import json
import boto3
import os
import base64
import requests

API_ENDPOINT = os.environ['API_ENDPOINT']




try:
    gatewayapi = boto3.client("apigatewaymanagementapi", endpoint_url=API_ENDPOINT)
    bedrock_runtime_client = boto3.client("bedrock-runtime", region_name="us-east-1")
    polly_client = boto3.client("polly", region_name="us-east-1")
except Exception as e:
    print(f"Erro ao inicializar clientes AWS: {e}")
    gatewayapi = None
    bedrock_runtime_client = None
    polly_client = None


def lambda_handler(event, context):
    if not bedrock_runtime_client or not gatewayapi or not polly_client:
        print("ERRO: Clientes AWS não inicializados.")
        return {"statusCode": 500}

    connection_id = event['requestContext']['connectionId']

    try:
        body = json.loads(event.get("body", "{}"))
        action = body.get("action")
        if action != "resposta":
            return {"statusCode": 200}

        prompt = body.get("prompt")
        history = body.get("history", [])

        if not prompt:
            gatewayapi.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({"error": "Parâmetro 'prompt' não encontrado."}).encode("utf-8")
            )
            return {"statusCode": 400}
    except Exception as e:
        print(f"Erro ao processar entrada: {e}")
        return {"statusCode": 400}

    # 1. Atualiza histórico
    history.append({"role": "user", "content": [{"type": "text", "text": prompt}]})

    # 2. Prepara payload Bedrock
    model_id = "anthropic.claude-3-haiku-20240307-v1:0"
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2048,
        "system": (
        "Você é Kora, uma assistente virtual infantil que ajuda na educação de crianças. "
        "Sempre se apresente na primeira resposta de cada conversa dizendo: 'Oi, prazer, eu sou Kora! Estou aqui para aprendermos juntos e também para brincar! Qual o seu nome?'"
        "Use frases curtas e linguagem simples, sem termos técnicos ou palavras difíceis. "
        "Jamais use palavrões ou linguagem ofensiva. "
        "Seja educado, amigável e positivo em todas as respostas. "
        "Nunca se prolongue demais nas explicações, a menos que a criança peça explicitamente para você contar uma história — "
        "nesses casos, você pode se estender e ser criativo."
    ),
        "messages": history
    }

    try:
        # 3. Invoca o modelo
        response = bedrock_runtime_client.invoke_model(
            body=json.dumps(payload),
            modelId=model_id
        )
        response_json = json.loads(response.get("body").read())
        bedrock_text = response_json["content"][0]["text"]
        history.append({"role": "assistant", "content": [{"type": "text", "text": bedrock_text}]})

        # --- 4. Gera e envia o áudio completo em chunks ---
        MAX_CHUNK_SIZE = 32000

        KOKORO_URL = "http://kokorotts.oraculo:8880/v1/audio/speech"  # ou IP privado da EC2

        try:
            with requests.post(
                KOKORO_URL,
                json={
                    "model": "kokoro",
                    "voice": "pm_santa",
                    "input": bedrock_text,
                    "response_format": "pcm",
                    "speed": 1.0
                },
                stream=True,
                timeout=60
            ) as r:
                r.raise_for_status()
                buffer = b""
                for chunk in r.iter_content(chunk_size=4096):
                    if not chunk:
                        continue
                    buffer += chunk
                    while len(buffer) >= MAX_CHUNK_SIZE:
                        part = buffer[:MAX_CHUNK_SIZE]
                        buffer = buffer[MAX_CHUNK_SIZE:]
                        part_b64 = base64.b64encode(part).decode("utf-8")
                        gatewayapi.post_to_connection(
                            ConnectionId=connection_id,
                            Data=json.dumps({
                                "type": "audio_chunk",
                                "chunk": part_b64,
                                "eof": False
                            }).encode("utf-8")
                        )

                # Envia o restante (caso sobre algo)
                if buffer:
                    part_b64 = base64.b64encode(buffer).decode("utf-8")
                    gatewayapi.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({
                            "type": "audio_chunk",
                            "chunk": part_b64,
                            "eof": False
                        }).encode("utf-8")
                    )

                # ✅ Envia sinal de fim de áudio
                gatewayapi.post_to_connection(
                    ConnectionId=connection_id,
                    Data=json.dumps({
                        "type": "audio_chunk",
                        "eof": True
                    }).encode("utf-8")
                )

        except Exception as e:
            print(f"Erro ao gerar áudio via Kokoro: {e}")
            gatewayapi.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({"error": "Falha ao gerar áudio com Kokoro."}).encode("utf-8")
            )
            return {"statusCode": 500}
        






        # 5. Mensagem final com texto e histórico
        final_payload = {
            "type": "final",
            "response": bedrock_text,
            "updated_history": history
        }
        gatewayapi.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(final_payload).encode("utf-8")
        )

        return {"statusCode": 200}

    except Exception as e:
        print(f"Erro ao processar Bedrock/Polly: {e}")
        return {"statusCode": 500}
