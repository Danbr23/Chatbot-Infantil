import json
import boto3
import base64
import psycopg2
import psycopg2.extras
import os

DB_HOST = os.getenv("DB_HOST")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_NAME = os.getenv("DB_NAME")

conn = None

def get_connection():
    global conn
    if conn is None or conn.closed != 0:
        conn = psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            dbname=DB_NAME,
        )
    return conn

REGION = "us-east-1"

bedrock_runtime_client = boto3.client(
    service_name="bedrock-runtime",
    region_name=REGION,
)

polly_client = boto3.client(
    service_name="polly",
    region_name=REGION,
)

MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"


def lambda_handler(event, context):
    # Log para debug
    connection = get_connection()
    print("EVENTO RECEBIDO:", json.dumps(event, indent=2, ensure_ascii=False))

    # --------------------------------------------------------
    # 1) Normalizar o body
    # --------------------------------------------------------
    # Caso 1: integração proxy (event["body"] é string JSON)
    if "body" in event:
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return _response(
                400,
                {"error": "Body inválido (não é JSON)."}
            )
    else:
        # Caso 2: integração não-proxy – o próprio event já é o body
        if isinstance(event, dict):
            body = event
        else:
            # caso extremo, converte para dict vazio
            body = {}

    action = body.get("action")
    if action != "invokeBedrock":
        return _response(
            200,
            {
                "message": "Ação ignorada.",
                "received_body": body,
            },
        )

    codigo_robo = body.get("codigo_robo")
    prompt = body.get("prompt")
    history = body.get("history", [])
    print(codigo_robo)
    with connection.cursor() as cur:
        sql = "SELECT id FROM robo WHERE codigo = %s;"
        cur.execute(sql, (codigo_robo,))   
        row = cur.fetchone()
        # if len(row) == 0:
        #     return _response(
        #         200,
        #         {
        #             "message": "Código do Robo não encontrado.",
        #             "received_body": body,
        #         },
        #     )

    id_robo = int(row[0])
    print(id_robo)
    with connection.cursor() as cur:
        sql = "SELECT preferencias_iniciais FROM parametros_iniciais WHERE id_robo = %s;"
        cur.execute(sql, (id_robo,))   
        row = cur.fetchone()

    preferencias_iniciais = row[0]
    print(preferencias_iniciais)

    if not prompt:
        return _response(
            400,
            {"error": 'O parâmetro "prompt" não foi encontrado.'},
        )

    # --------------------------------------------------------
    # 2) Montar histórico para o Claude (Bedrock)
    # --------------------------------------------------------
    history.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
            ],
        }
    )

    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2048,
        "system": preferencias_iniciais,
        "messages": history,
    }

    try:
        # --------------------------------------------------------
        # 3) Chamar Bedrock
        # --------------------------------------------------------
        print("Antes do Bedrock")
        bedrock_response = bedrock_runtime_client.invoke_model(
            body=json.dumps(payload),
            modelId=MODEL_ID,
        )

        print("Chega aqui?")
        response_body_json = json.loads(bedrock_response["body"].read())
        bedrock_response_text = response_body_json["content"][0]["text"]

        history.append(
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": bedrock_response_text},
                ],
            }
        )

        # --------------------------------------------------------
        # 4) Chamar Polly – gerar áudio em PCM 16 kHz
        # --------------------------------------------------------
        polly_response = polly_client.synthesize_speech(
            Text=bedrock_response_text,
            OutputFormat="pcm",   # PCM cru
            SampleRate="16000",   # 16 kHz
            VoiceId="Ricardo",    # ajuste a voz se quiser
        )

        audio_bytes = polly_response["AudioStream"].read()
        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

        response_payload = {
            "response": bedrock_response_text,
            "updated_history": history,
            "audio_base64": audio_base64,
            "audio_format": "pcm",
            "sample_rate": 16000,
        }

        print("Resposta final:", json.dumps(response_payload, ensure_ascii=False)[:500])

        return _response(200, response_payload)

    except Exception as e:
        print(f"ERRO ao processar Bedrock/Polly: {e}")
        return _response(
            500,
            {"error": "Erro interno ao gerar resposta de voz."},
        )


def _response(status_code: int, body_dict: dict):
    """Helper para montar resposta HTTP da Lambda REST."""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body_dict),
    }
