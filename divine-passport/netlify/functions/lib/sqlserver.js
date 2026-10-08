const sql = require("mssql");

let poolPromise;

function configuration() {
  const configuredServer = process.env.SQLSERVER_SERVER || "";
  const [server, inferredInstance] = configuredServer.split("\\", 2);
  const instanceName = process.env.SQLSERVER_INSTANCE || inferredInstance;
  const database = process.env.SQLSERVER_DATABASE || "divine_passport";
  const user = process.env.SQLSERVER_USER;
  const password = process.env.SQLSERVER_PASSWORD;

  if (!server || !user || !password) {
    throw new Error("SQL Server is not configured. Set SQLSERVER_SERVER, SQLSERVER_USER, and SQLSERVER_PASSWORD.");
  }

  return {
    server,
    database,
    user,
    password,
    ...(process.env.SQLSERVER_PORT
      ? { port: Number(process.env.SQLSERVER_PORT) }
      : instanceName ? {} : { port: 1433 }),
    options: {
      ...(instanceName ? { instanceName } : {}),
      encrypt: process.env.SQLSERVER_ENCRYPT !== "false",
      trustServerCertificate: process.env.SQLSERVER_TRUST_CERT === "true",
      enableArithAbort: true,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
  };
}

function translate(statement) {
  let index = 0;
  const text = statement.replace(/\?/g, () => `@p${index++}`);
  return { text, parameterCount: index };
}

async function connection() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(configuration()).connect().catch(error => {
      poolPromise = undefined;
      throw error;
    });
  }
  return poolPromise;
}

function queryOn(target, statement, values = []) {
  return (async () => {
    const { text, parameterCount } = translate(statement);
    if (parameterCount !== values.length) {
      throw new Error(`SQL parameter count mismatch: expected ${parameterCount}, received ${values.length}.`);
    }
    const request = target.request();
    values.forEach((value, index) => request.input(`p${index}`, value ?? null));
    const result = await request.query(text);
    if (result.recordset) return [result.recordset];
    return [{ affectedRows: (result.rowsAffected || []).reduce((total, count) => total + count, 0) }];
  })();
}

function wrap() {
  return {
    query: async (statement, values = []) => queryOn(await connection(), statement, values),
    execute: async (statement, values = []) => queryOn(await connection(), statement, values),
    async getConnection() {
      const transaction = new sql.Transaction(await connection());
      return {
        beginTransaction: () => transaction.begin(),
        commit: () => transaction.commit(),
        rollback: () => transaction.rollback(),
        release: () => {},
        execute: (statement, values = []) => queryOn(transaction, statement, values),
      };
    },
  };
}

module.exports = function database() {
  return wrap();
};

module.exports.translate = translate;
