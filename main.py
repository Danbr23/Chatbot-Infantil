import asyncio
import base64
import json
import sys
import threading
import time

import boto3
import numpy as np
import requests
import sounddevice as sd

from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler

# =====================================
# CONFIGURAÇÕES
# =====================================

conversation_history = []
codigo_robo = ""


REGION = "us-east-1"

# Transcribe
LANGUAGE_CODE = "pt-BR"
SAMPLE_RATE = 16000  # taxa de amostragem do áudio que vamos mandar para o Transcribe

# Sua API REST (Lambda com Bedrock + Polly)
API_URL = "https://h5nfq4dzd2.execute-api.us-east-1.amazonaws.com/prod"  # <-- troque
API_ACTION = "invokeBedrock"

# Tamanho dos chunks de áudio enviados ao Transcribe (em milissegundos)
CHUNK_MS = 100


# =====================================
# 1) GRAVAÇÃO DO MICROFONE (ENTER/ENTER)
# =====================================

def record_audio_until_enter():
    """
    Pressione ENTER para começar a gravar.
    Pressione ENTER novamente para parar.
    Retorna um numpy array int16 com o áudio gravado (mono, SAMPLE_RATE).
    """
    print("Pressione ENTER para começar a gravar (ou 'q' + ENTER para sair).")
    cmd = input().strip().lower()
    if cmd == "q":
        return None, True  # (audio, quit_flag)

    print("Gravando... pressione ENTER novamente para parar.")

    recording = []
    stop_flag = {"stop": False}

    def callback(indata, frames, time_info, status):
        if status:
            print(f"[WARN] status do stream: {status}", file=sys.stderr)
        # indata é float32 em [-1, 1]
        recording.append(indata.copy())

    def wait_for_enter():
        input()  # segundo ENTER
        stop_flag["stop"] = True

    stopper = threading.Thread(target=wait_for_enter, daemon=True)
    stopper.start()

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        callback=callback,
    ):
        while not stop_flag["stop"]:
            time.sleep(0.05)

    print("Gravação encerrada.")

    if not recording:
        print("Nenhum áudio gravado.")
        return None, False

    audio_float = np.concatenate(recording, axis=0)  # shape (N, 1) ou (N,)
    if audio_float.ndim > 1:
        audio_float = audio_float[:, 0]
    audio_int16 = (audio_float * 32767).astype(np.int16)
    return audio_int16, False


# =====================================
# 2) HANDLER DO TRANSCRIBE STREAMING
# =====================================

class MyTranscriptHandler(TranscriptResultStreamHandler):
    def __init__(self, stream):
        super().__init__(stream)
        self.segments = []

    async def handle_transcript_event(self, transcript_event):
        # Chamado toda vez que chegam resultados de transcrição
        for result in transcript_event.transcript.results:
            if result.is_partial:
                # Ignora parciais; pega só finais
                continue
            for alt in result.alternatives:
                text = alt.transcript
                self.segments.append(text)

    def get_full_text(self) -> str:
        # Junta segmentos em um único texto
        return " ".join(self.segments).strip()


# =====================================
# 3) ENVIAR ÁUDIO GRAVADO PARA O TRANSCRIBE VIA STREAMING
# =====================================

async def transcribe_with_streaming(audio_int16: np.ndarray) -> str:
    """
    Envia o áudio (int16, PCM, mono) para o Amazon Transcribe Streaming
    e retorna o texto transcrito.
    NÃO usa S3. O áudio é "streamado" diretamente daqui.
    """
    client = TranscribeStreamingClient(region=REGION)

    stream = await client.start_stream_transcription(
        language_code=LANGUAGE_CODE,
        media_sample_rate_hz=SAMPLE_RATE,
        media_encoding="pcm",
    )

    handler = MyTranscriptHandler(stream.output_stream)

    # função para enviar os chunks de áudio
    async def write_chunks():
        bytes_audio = audio_int16.tobytes()
        bytes_per_sample = 2  # int16
        samples_per_chunk = int(SAMPLE_RATE * CHUNK_MS / 1000)
        bytes_per_chunk = samples_per_chunk * bytes_per_sample

        for start in range(0, len(bytes_audio), bytes_per_chunk):
            chunk = bytes_audio[start:start + bytes_per_chunk]
            if not chunk:
                break
            await stream.input_stream.send_audio_event(audio_chunk=chunk)
            # pequeno intervalo para simular streaming; opcional
            await asyncio.sleep(CHUNK_MS / 1000.0)

        # sinaliza fim do áudio
        await stream.input_stream.end_stream()

    # executa envio e leitura em paralelo
    await asyncio.gather(
        write_chunks(),
        handler.handle_events()
    )

    text = handler.get_full_text()
    print("Texto transcrito:", text)
    return text


# =====================================
# 4) CHAMAR SUA API (BEDROCK + POLLY) COM O TEXTO TRANSCRITO
# =====================================

def call_bedrock_polly_api(prompt_text: str, history: list, cod_robo: str):
    payload = {
        "action": API_ACTION,
        "prompt": prompt_text,
        "history": history,
        "codigo_robo": cod_robo,
    }

    print("Chamando API REST:", API_URL)
    resp = requests.post(API_URL, json=payload)

    print("Status:", resp.status_code)
    print("Resposta bruta (inicio):", resp.text[:300], "...\n")

    resp.raise_for_status()
    data = resp.json()

    # Se a Lambda estiver em modo "proxy", data = {statusCode, headers, body}
    # e body é uma string JSON. Precisamos abrir essa string.
    if "body" in data and isinstance(data["body"], str):
        try:
            inner = json.loads(data["body"])
        except json.JSONDecodeError:
            raise RuntimeError("Body retornado não é um JSON válido.")
    else:
        inner = data

    resposta_texto = inner.get("response", "")
    audio_b64 = inner.get("audio_base64")
    sample_rate = inner.get("sample_rate", SAMPLE_RATE)
    updated_history = inner.get("updated_history", history)

    if not audio_b64:
        print("DEBUG inner:", inner)
        raise RuntimeError("Resposta da API não contém 'audio_base64'.")

    audio_bytes = base64.b64decode(audio_b64)
    print("Texto da IA:", resposta_texto)
    return resposta_texto, audio_bytes, sample_rate, updated_history



# =====================================
# 5) TOCAR ÁUDIO PCM no NOTEBOOK
# =====================================

def play_pcm(audio_bytes: bytes, sample_rate: int):
    """
    Toca áudio PCM 16-bit little endian, mono, vindo da API.
    """
    samples = np.frombuffer(audio_bytes, dtype=np.int16)
    print(f"Tocando áudio ({len(samples)} amostras, {sample_rate} Hz)...")
    sd.play(samples, samplerate=sample_rate)
    sd.wait()
    print("Reprodução concluída.")


# =====================================
# 6) LOOP PRINCIPAL
# =====================================

# async def main():
#     while True:
#         # audio_int16, quit_flag = record_audio_until_enter()
#         # if quit_flag:
#         #     print("Saindo.")
#         #     break

#         # if audio_int16 is None or len(audio_int16) == 0:
#         #     continue

#         # # 1) Transcrever com Transcribe Streaming (sem S3)
#         # user_text = await transcribe_with_streaming(audio_int16)
#         # if not user_text:
#         #     print("Nenhum texto transcrito.")
#         #     continue

#         user_text = input("Escreva alguma coisa")

#         # 2) Enviar texto para sua API REST
#         _, audio_bytes, sr = call_bedrock_polly_api(user_text)

#         # 3) Tocar áudio retornado
#         play_pcm(audio_bytes, sr)

async def main():
    global conversation_history
    global codigo_robo 
    codigo_robo = input("Digite o codigo do robo")
    while True:
        user_text = input("Escreva alguma coisa: ")

        # envia texto + histórico acumulado
        resposta_texto, audio_bytes, sr, updated_history = call_bedrock_polly_api(
            user_text,
            conversation_history,
            codigo_robo
        )

        # atualiza o histórico no cliente
        conversation_history[:] = updated_history

        # toca o áudio
        play_pcm(audio_bytes, sr)



if __name__ == "__main__":
    asyncio.run(main())
