import { Client } from "pg";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

// --- CONFIGURAÇÕES ---
const region = "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const appClientId = process.env.COGNITO_APP_CLIENT_ID;

// Credenciais do banco de dados
const dbHost = process.env.DB_HOST;
const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;

// Configuração do CORS
const headersCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
};

// Configuração do JWKS (Chaves públicas do Cognito)
const client = jwksClient({
  jwksUri: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
});

// Função auxiliar para obter a chave de assinatura
const getKey = (header, callback) => {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err, null);
    } else {
      const signingKey = key.publicKey || key.rsaPublicKey;
      callback(null, signingKey);
    }
  });
};

export const handler = async (event) => {
  // 1. LOG DE DEBUG: Essencial para ver o que o API Gateway enviou
  console.log("EVENTO RECEBIDO:", JSON.stringify(event, null, 2));

  let dbClient;

  try {
    // 2. EXTRAÇÃO SEGURA DOS HEADERS
    // Garante que headers existe e normaliza as chaves para minúsculo
    const headers = event.headers || {};
    const normalizedHeaders = {};
    
    Object.keys(headers).forEach((key) => {
      normalizedHeaders[key.toLowerCase()] = headers[key];
    });

    // Busca o header 'authorization' (agora garantido estar em minúsculo se existir)
    const rawToken = normalizedHeaders['authorization'];

    if (!rawToken) {
      console.warn("Header Authorization não encontrado no evento.");
      return {
        statusCode: 401,
        headers: headersCORS,
        body: JSON.stringify({ message: "Token de autorização não fornecido." }),
      };
    }

    // 3. LIMPEZA DO TOKEN
    // Remove "Bearer " (case insensitive) usando Regex
    const tokenClean = rawToken.replace(/^Bearer\s+/i, "");

    // 4. VALIDAÇÃO DO JWT
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(
        tokenClean,
        getKey,
        { audience: appClientId },
        (err, decodedToken) => {
          if (err) {
            console.error("Erro JWT:", err.message);
            reject({ statusCode: 401, message: "Token inválido ou expirado" });
          } else {
            resolve(decodedToken);
          }
        }
      );
    });

    const userId = decoded.sub;
    console.log("Usuário autenticado:", userId);

    // 5. CONEXÃO E CONSULTA AO BANCO
    dbClient = new Client({
      host: dbHost,
      database: dbName,
      user: dbUser,
      password: dbPassword,
      port: 5432,
      ssl: {
        rejectUnauthorized: false
      }
    });

    await dbClient.connect();

    const robosRes = await dbClient.query(
      `SELECT
    -- Dados do Robô
    r.id AS robo_id,
    r.codigo AS robo_codigo,
    r.nome AS robo_nome,
    r.status AS robo_status,
    r.created_at AS robo_criacao,

    -- Dados dos Parâmetros Iniciais
    pi.id AS param_id,
    pi.id_usuario_cognito,
    pi.preferencias_iniciais,

    -- Dados do Histórico
    hc.id AS historico_id,
    hc.historico AS conteudo_conversa,
    hc.data_registro AS data_conversa

    FROM robo r
    -- Junta com parâmetros para filtrar pelo dono do robô
    INNER JOIN parametros_iniciais pi ON r.id = pi.id_robo
    -- Junta com histórico (LEFT JOIN para trazer o robô mesmo se não houver conversa ainda)
    LEFT JOIN historico_conversa hc ON r.id = hc.id_robo

    WHERE pi.id_usuario_cognito = $1;`,
      [userId]
    );

    // 6. RETORNO DE SUCESSO
    return {
      statusCode: 200,
      headers: headersCORS,
      body: JSON.stringify(robosRes.rows),
    };

  } catch (err) {
    console.error("Erro na execução da Lambda:", err);

    // Tratamento para erros personalizados (como o do JWT reject acima) vs erros genéricos
    const statusCode = err.statusCode || 500;
    const message = err.message || "Erro interno no servidor";

    return {
      statusCode: statusCode,
      headers: headersCORS,
      body: JSON.stringify({ message: message }),
    };

  } finally {
    // 7. FECHAMENTO DA CONEXÃO (SEMPRE EXECUTADO)
    if (dbClient) {
      try {
        await dbClient.end();
        console.log("Conexão com BD encerrada.");
      } catch (closeErr) {
        console.error("Erro ao fechar conexão com BD:", closeErr);
      }
    }
  }
};
