import json
import boto3
import os

# --- Clientes AWS ---
API_ENDPOINT = os.environ['API_ENDPOINT']

try:
    gatewayapi = boto3.client("apigatewaymanagementapi", endpoint_url=API_ENDPOINT)
    bedrock_runtime_client = boto3.client(
        service_name='bedrock-runtime',
        region_name='us-east-1'
    )
except Exception as e:
    print(f"ERRO ao inicializar clientes AWS: {e}")
    gatewayapi = None
    bedrock_runtime_client = None

def lambda_handler(event, context):
    if not bedrock_runtime_client or not gatewayapi:
        print("ERRO: Clientes AWS não inicializados.")
        return {'statusCode': 500}

    connection_id = event['requestContext']['connectionId']
    
    try:
        body = json.loads(event.get('body', '{}'))
        action = body.get('action')
        
        if action != 'invokeBedrock':
            return {'statusCode': 200}

        prompt = body.get('prompt')
        # Recebe o histórico da conversa. Se não vier, começa com uma lista vazia.
        history = body.get('history', [])

        if not prompt:
            gatewayapi.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({'error': 'O parâmetro "prompt" não foi encontrado.'}).encode('utf-8')
            )
            return {'statusCode': 400}
    except Exception as e:
        # ... (tratamento de erro) ...
        return {'statusCode': 400}

    # --- Lógica de Conversa ---
    # 1. Adiciona a nova mensagem do usuário ao histórico
    # O formato de mensagens do Claude espera um dicionário com 'role' e 'content'
    history.append({"role": "user", "content": [{"type": "text", "text": prompt}]})

    # 2. Configura o payload para o Bedrock com o histórico completo
    model_id = 'anthropic.claude-3-haiku-20240307-v1:0'
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2048,
        "messages": history # AQUI ESTÁ A MUDANÇA PRINCIPAL!
    }

    try:
        response = bedrock_runtime_client.invoke_model(body=json.dumps(payload), modelId=model_id)
        response_body_json = json.loads(response.get('body').read())
        bedrock_response_text = response_body_json['content'][0]['text']
        
        # 3. Adiciona a resposta do modelo (assistente) ao histórico
        history.append({"role": "assistant", "content": [{"type": "text", "text": bedrock_response_text}]})
        
        # 4. Envia a resposta E o histórico atualizado de volta para o cliente
        response_payload = {
            'response': bedrock_response_text,
            'updated_history': history # Envia o histórico completo de volta
        }
        
        gatewayapi.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(response_payload).encode('utf-8')
        )
        
        return {'statusCode': 200}

    except Exception as e:
        print(f"ERRO ao processar no Bedrock: {e}")
        # ... (tratamento de erro) ...
        return {'statusCode': 500}