import { Client } from "pg";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import crypto from "crypto";
import {
  KMSClient,
  DecryptCommand,
} from "@aws-sdk/client-kms";

// --- CONFIGURAÇÕES ---
const region = "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const appClientId = process.env.COGNITO_APP_CLIENT_ID;
const kmsKeyId = process.env.KMS_KEY_ID;

// KMS client
const kms = new KMSClient({ region });

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

// --- CRIPTO: decrypt AES-256-GCM com layout [IV(12)][TAG(16)][CIPHERTEXT] ---
function decryptWithDataKey(buffer, dataKeyBuffer) {
  if (!buffer || buffer.length === 0) return "";

  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKeyBuffer, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString("utf8");
}

// --- HANDLER PRINCIPAL ---
export const handler = async (event) => {
  console.log("EVENTO RECEBIDO:", JSON.stringify(event, null, 2));

  let dbClient;

  try {
    // 1. EXTRAÇÃO SEGURA DOS HEADERS
    const headers = event.headers || {};
    const normalizedHeaders = {};
    Object.keys(headers).forEach((key) => {
      normalizedHeaders[key.toLowerCase()] = headers[key];
    });

    const rawToken = normalizedHeaders["authorization"];

    if (!rawToken) {
      console.warn("Header Authorization não encontrado no evento.");
      return {
        statusCode: 401,
        headers: headersCORS,
        body: JSON.stringify({ message: "Token de autorização não fornecido." }),
      };
    }

    const tokenClean = rawToken.replace(/^Bearer\s+/i, "");

    // 2. VALIDAÇÃO DO JWT
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

    // 3. CONEXÃO AO BANCO
    dbClient = new Client({
      host: dbHost,
      database: dbName,
      user: dbUser,
      password: dbPassword,
      port: 5432,
      ssl: {
        rejectUnauthorized: false,
      },
    });

    await dbClient.connect();

    // 4. Buscar robôs + parâmetros + histórico + dek_encrypted
    const robosRes = await dbClient.query(
      `
      SELECT
        -- Dados do Robô
        r.id AS robo_id,
        r.codigo AS robo_codigo,
        r.nome AS robo_nome,
        r.status AS robo_status,
        r.created_at AS robo_criacao,
        r.dek_encrypted AS robo_dek_encrypted,

        -- Dados dos Parâmetros Iniciais
        pi.id AS param_id,
        pi.id_usuario_cognito,
        pi.preferencias_iniciais,

        -- Dados do Histórico
        hc.id AS historico_id,
        hc.historico AS conteudo_conversa,
        hc.data_registro AS data_conversa

      FROM robo r
      INNER JOIN parametros_iniciais pi ON r.id = pi.id_robo
      LEFT JOIN historico_conversa hc ON r.id = hc.id_robo
      WHERE pi.id_usuario_cognito = $1;
      `,
      [userId]
    );

    const rows = robosRes.rows;

    // 5. Para cada robô, decifrar prefs + histórico usando o DEK do robo
    const result = [];

    for (const row of rows) {
      const dekEncrypted = row.robo_dek_encrypted; // BYTEA -> Buffer no node-postgres
      let decryptedPrefs = null;
      let decryptedHistory = null;

      if (dekEncrypted) {
        // Decriptar DEK com KMS
        const decryptResp = await kms.send(
          new DecryptCommand({
            KeyId: kmsKeyId,
            CiphertextBlob: dekEncrypted,
            EncryptionContext: { service: "chatbot_infantil" },
          })
        );
        const dataKey = Buffer.from(decryptResp.Plaintext);

        // prefs
        if (row.preferencias_iniciais) {
          const prefsBuf = Buffer.isBuffer(row.preferencias_iniciais)
            ? row.preferencias_iniciais
            : Buffer.from(row.preferencias_iniciais, "base64"); // fallback se estiver como texto
          const prefsText = decryptWithDataKey(prefsBuf, dataKey);
          let prefsParsed = null;
          if (prefsText && prefsText.trim() !== "") {
            try {
              prefsParsed = JSON.parse(prefsText);   // se for JSON válido
            } catch (e) {
              // se não for JSON, trata como string simples
              prefsParsed = prefsText;
            }
          }
          decryptedPrefs = prefsParsed;
        }

        // histórico (pode estar vazio ou null)
        if (row.conteudo_conversa) {
          const histBuf = Buffer.isBuffer(row.conteudo_conversa)
            ? row.conteudo_conversa
            : Buffer.from(row.conteudo_conversa, "base64");
          const histText = decryptWithDataKey(histBuf, dataKey);
          decryptedHistory = histText || "";
        }
      }

      result.push({
        robo_id: row.robo_id,
        robo_codigo: row.robo_codigo,
        robo_nome: row.robo_nome,
        robo_status: row.robo_status,
        robo_criacao: row.robo_criacao,

        param_id: row.param_id,
        id_usuario_cognito: row.id_usuario_cognito,
        preferencias_iniciais: decryptedPrefs, // já em JSON

        historico_id: row.historico_id,
        conteudo_conversa: decryptedHistory,   // string JSON ou "", dependendo do que você salvar
        data_conversa: row.data_conversa,
      });
    }

    // 6. RETORNO DE SUCESSO
    return {
      statusCode: 200,
      headers: headersCORS,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error("Erro na execução da Lambda:", err);

    const statusCode = err.statusCode || 500;
    const message = err.message || "Erro interno no servidor";

    return {
      statusCode: statusCode,
      headers: headersCORS,
      body: JSON.stringify({ message: message }),
    };
  } finally {
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
