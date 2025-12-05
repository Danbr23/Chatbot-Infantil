import { Client } from "pg";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

// --- CONFIGURAÇÕES ---
const region = "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const appClientId = process.env.COGNITO_APP_CLIENT_ID;

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
    const { httpMethod, path, pathParameters, resource } = event;
    const body = event.body ? JSON.parse(event.body) : {};

    // ROTA: CRIAR ROBÔ (POST /robots)
    // Verifica se o path termina em /robots ou se é a raiz da rota configurada
    if (httpMethod === "POST" && !pathParameters?.id) {
      return await createRobot(dbClient, userId, body);
    }

    // ROTA: DELETAR ROBÔ (DELETE /robots/{id})
    if (httpMethod === "DELETE" && pathParameters?.id) {
      return await deleteRobot(dbClient, userId, pathParameters.id);
    }

    // ROTA: LIMPAR HISTÓRICO (POST /robots/{id}/clear-history)
    // Verifica se o path contém "clear-history"
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
    // Faz Rollback se houver transação aberta e erro
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

// 1. Criar Robô (Com transação, nome e histórico inicial)
async function createRobot(client, userId, body) {
  // Extraímos explicitamente o 'name' do corpo da requisição
  const { code, name, params } = body;

  if (!code)
    throw { statusCode: 400, message: "O campo 'code' é obrigatório." };
  if (!name)
    throw {
      statusCode: 400,
      message: "O campo 'name' (nome do robô) é obrigatório.",
    };

  try {
    await client.query("BEGIN"); // Inicia Transação

    // --- PASSO 1: Inserir na tabela ROBO ---
    const insertRoboQuery = `
      INSERT INTO robo (codigo, nome, status)
      VALUES ($1, $2, 'ATIVO')
      RETURNING id;
    `;
    // Aqui passamos o 'name' vindo do body para a coluna 'nome' ($2)
    const resRobo = await client.query(insertRoboQuery, [code, name]);
    const newRoboId = resRobo.rows[0].id;

    // --- PASSO 2: Inserir na tabela PARAMETROS_INICIAIS ---
    const paramsText =
      typeof params === "object" ? JSON.stringify(params) : params;

    const insertParamsQuery = `
      INSERT INTO parametros_iniciais (id_usuario_cognito, preferencias_iniciais, id_robo)
      VALUES ($1, $2, $3);
    `;
    await client.query(insertParamsQuery, [userId, paramsText, newRoboId]);

    // --- PASSO 3: Inicializar HISTORICO_CONVERSA (Vazio) ---
    const insertHistoryQuery = `
      INSERT INTO historico_conversa (historico, id_robo, id_usuario_cognito)
      VALUES ($1, $2, $3);
    `;
    await client.query(insertHistoryQuery, ["", newRoboId, userId]);

    await client.query("COMMIT"); // Salva tudo

    return {
      statusCode: 201,
      headers: headersCORS,
      body: JSON.stringify({
        message: "Robô criado com sucesso",
        id: newRoboId,
      }),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw { statusCode: 409, message: "Já existe um robô com este código." };
    }
    throw error;
  }
}

// 2. Deletar Robô
async function deleteRobot(client, userId, roboId) {
  // Apenas deletamos se o usuário for o dono (verificado via join ou subquery)
  // Como o ON DELETE CASCADE está configurado nas chaves estrangeiras,
  // deletar o robô remove automaticamente os parâmetros e o histórico.

  const query = `
    DELETE FROM robo
    WHERE id = $1 
    AND id IN (
        SELECT id_robo FROM parametros_iniciais WHERE id_usuario_cognito = $2
    )
    RETURNING id;
  `;

  const res = await client.query(query, [roboId, userId]);

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
async function clearHistory(client, userId, roboId) {
  // Primeiro verificamos se o robô pertence ao usuário
  const checkOwner = await client.query(
    "SELECT id FROM parametros_iniciais WHERE id_robo = $1 AND id_usuario_cognito = $2",
    [roboId, userId]
  );

  if (checkOwner.rowCount === 0) {
    throw { statusCode: 403, message: "Permissão negada ou robô inexistente." };
  }

  // Deleta histórico desse robô E desse usuário
  const deleteQuery = `
    DELETE FROM historico_conversa 
    WHERE id_robo = $1 AND id_usuario_cognito = $2;
  `;

  await client.query(deleteQuery, [roboId, userId]);

  return {
    statusCode: 200,
    headers: headersCORS,
    body: JSON.stringify({ message: "Histórico limpo com sucesso." }),
  };
}
