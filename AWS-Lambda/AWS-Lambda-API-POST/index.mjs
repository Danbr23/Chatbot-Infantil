import { Client } from "pg";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import crypto from "crypto";
import {
  KMSClient,
  GenerateDataKeyCommand,
} from "@aws-sdk/client-kms";

// --- CONFIGURAÇÕES ---
const region = "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const appClientId = process.env.COGNITO_APP_CLIENT_ID;
const kmsKeyId = process.env.KMS_KEY_ID;

// KMS client
const kms = new KMSClient({ region });

// Credenciais do Banco
const dbConfig = {
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: { rejectUnauthorized: false },
};

// Headers CORS
const headersCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST,DELETE,GET",
};

// Configuração JWKS
const client = jwksClient({
  jwksUri: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
});

const getKey = (header, callback) => {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) callback(err, null);
    else callback(null, key.publicKey || key.rsaPublicKey);
  });
};

// --- FUNÇÃO AUXILIAR DE AUTH ---
async function authenticate(event) {
  const headers = event.headers || {};
  const normalizedHeaders = {};
  Object.keys(headers).forEach(
    (key) => (normalizedHeaders[key.toLowerCase()] = headers[key])
  );

  const rawToken = normalizedHeaders["authorization"];
  if (!rawToken) throw { statusCode: 401, message: "Token não fornecido" };

  const tokenClean = rawToken.replace(/^Bearer\s+/i, "");

  return new Promise((resolve, reject) => {
    jwt.verify(
      tokenClean,
      getKey,
      { audience: appClientId },
      (err, decoded) => {
        if (err) {
          console.error("Erro JWT:", err.message);
          reject({ statusCode: 401, message: "Token inválido ou expirado" });
        } else {
          resolve(decoded.sub); // Retorna o ID do usuário (sub)
        }
      }
    );
  });
}

// --- CRIPTO AUXILIAR (AES-256-GCM) ---
function encryptWithDataKey(plaintext, dataKeyBuffer) {
  const iv = crypto.randomBytes(12); // 96 bits
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKeyBuffer, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Layout: [IV(12)][TAG(16)][CIPHERTEXT]
  return Buffer.concat([iv, tag, ciphertext]);
}

// --- HANDLER PRINCIPAL ---
export const handler = async (event) => {
  console.log("EVENTO:", JSON.stringify(event, null, 2));

  // 1. Tratar Pre-flight (CORS)
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: headersCORS, body: "" };
  }

  let dbClient;

  try {
    // 2. Autenticação
    const userId = await authenticate(event);

    // 3. Conexão ao Banco
    dbClient = new Client(dbConfig);
    await dbClient.connect();

    // 4. Roteamento baseado no método e path
    const { httpMethod, path, pathParameters } = event;
    const body = event.body ? JSON.parse(event.body) : {};

    // ROTA: CRIAR ROBÔ (POST /robots)
    if (httpMethod === "POST" && !pathParameters?.id) {
      return await createRobot(dbClient, userId, body);
    }

    // ROTA: DELETAR ROBÔ (DELETE /robots/{id})
    if (httpMethod === "DELETE" && pathParameters?.id) {
      return await deleteRobot(dbClient, userId, pathParameters.id);
    }

    // ROTA: LIMPAR HISTÓRICO (POST /robots/{id}/clear-history)
    if (
      httpMethod === "POST" &&
      pathParameters?.id &&
      path.includes("clear-history")
    ) {
      return await clearHistory(dbClient, userId, pathParameters.id);
    }

    // Rota não encontrada
    return {
      statusCode: 404,
      headers: headersCORS,
      body: JSON.stringify({ message: "Rota não encontrada" }),
    };
  } catch (err) {
    console.error("Erro Lambda:", err);
    if (dbClient) await dbClient.query("ROLLBACK").catch(() => {});

    return {
      statusCode: err.statusCode || 500,
      headers: headersCORS,
      body: JSON.stringify({ message: err.message || "Erro interno" }),
    };
  } finally {
    if (dbClient) await dbClient.end();
  }
};

// --- LÓGICA DE NEGÓCIO ---

// 1. Criar Robô (gera DEK, salva no robo, cifra preferencias_iniciais)
async function createRobot(clientPg, userId, body) {
  const { code, name, params } = body;

  if (!code) throw { statusCode: 400, message: "O campo 'code' é obrigatório." };
  if (!name) throw { statusCode: 400, message: "O campo 'name' é obrigatório." };

  try {
    await clientPg.query("BEGIN");

    // PASSO 0: Gerar DEK para este robô
    const dataKeyResp = await kms.send(
      new GenerateDataKeyCommand({
        KeyId: kmsKeyId,
        KeySpec: "AES_256",
        EncryptionContext: { service: "chatbot_infantil" },
      })
    );

    const plaintextKey = Buffer.from(dataKeyResp.Plaintext);      // para cifrar prefs
    const encryptedKey = Buffer.from(dataKeyResp.CiphertextBlob); // vai para robo.dek_encrypted

    // PASSO 1: Inserir na tabela ROBO com dek_encrypted
    const insertRoboQuery = `
      INSERT INTO robo (codigo, nome, status, dek_encrypted)
      VALUES ($1, $2, 'ATIVO', $3)
      RETURNING id;
    `;
    const resRobo = await clientPg.query(insertRoboQuery, [
      code,
      name,
      encryptedKey,
    ]);
    const newRoboId = resRobo.rows[0].id;

    // PASSO 2: Inserir na tabela PARAMETROS_INICIAIS (cifrado)
    const paramsText =
      typeof params === "object" ? JSON.stringify(params) : (params || "");

    const encryptedPrefsBuf = encryptWithDataKey(paramsText, plaintextKey);

    const insertParamsQuery = `
      INSERT INTO parametros_iniciais (id_usuario_cognito, preferencias_iniciais, id_robo)
      VALUES ($1, $2, $3);
    `;
    await clientPg.query(insertParamsQuery, [
      userId,
      encryptedPrefsBuf, // BYTEA
      newRoboId,
    ]);

    // PASSO 3: Inicializar HISTORICO_CONVERSA (vazio)
    const insertHistoryQuery = `
      INSERT INTO historico_conversa (historico, id_robo, id_usuario_cognito)
      VALUES ($1, $2, $3);
    `;
    await clientPg.query(insertHistoryQuery, ["", newRoboId, userId]);

    await clientPg.query("COMMIT");

    return {
      statusCode: 201,
      headers: headersCORS,
      body: JSON.stringify({
        message: "Robô criado com sucesso",
        id: newRoboId,
      }),
    };
  } catch (error) {
    await clientPg.query("ROLLBACK");
    if (error.code === "23505") {
      throw { statusCode: 409, message: "Já existe um robô com este código." };
    }
    throw error;
  }
}

// 2. Deletar Robô
async function deleteRobot(clientPg, userId, roboId) {
  const query = `
    DELETE FROM robo
    WHERE id = $1 
      AND id IN (
        SELECT id_robo FROM parametros_iniciais WHERE id_usuario_cognito = $2
      )
    RETURNING id;
  `;

  const res = await clientPg.query(query, [roboId, userId]);

  if (res.rowCount === 0) {
    throw {
      statusCode: 404,
      message: "Robô não encontrado ou você não tem permissão para deletá-lo.",
    };
  }

  return {
    statusCode: 200,
    headers: headersCORS,
    body: JSON.stringify({ message: "Robô deletado com sucesso." }),
  };
}

// 3. Limpar Histórico
async function clearHistory(clientPg, userId, roboId) {
  const checkOwner = await clientPg.query(
    "SELECT id FROM parametros_iniciais WHERE id_robo = $1 AND id_usuario_cognito = $2",
    [roboId, userId]
  );

  if (checkOwner.rowCount === 0) {
    throw { statusCode: 403, message: "Permissão negada ou robô inexistente." };
  }

  const deleteQuery = `

    UPDATE historico_conversa
    SET historico = $1
    WHERE id_robo = $2 AND id_usuario_cognito = $3;

  `;

  await clientPg.query(deleteQuery, ["", roboId, userId]);

  return {
    statusCode: 200,
    headers: headersCORS,
    body: JSON.stringify({ message: "Histórico limpo com sucesso." }),
  };
}
