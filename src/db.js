const { Pool } = require("pg");

function sanitizeIdentifier(value, label) {
  const name = String(value || "").trim();
  if (!name) {
    throw new Error(`${label} obrigatorio.`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`${label} invalido: ${name}`);
  }
  return name;
}

function resolvePoolOptions(config) {
  const ssl = config.dbSsl ? { rejectUnauthorized: false } : false;
  if (config.dbUrl) {
    return {
      connectionString: config.dbUrl,
      ssl,
    };
  }

  if (!config.dbHost) {
    throw new Error("DB_HOST nao configurado.");
  }
  if (!config.dbName) {
    throw new Error("DB_NAME nao configurado.");
  }
  if (!config.dbUser) {
    throw new Error("DB_USER nao configurado.");
  }

  return {
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbName,
    user: config.dbUser,
    password: config.dbPassword,
    ssl,
  };
}

function createDatabase(config, debugLog) {
  const table = sanitizeIdentifier(config.dbTable, "DB_TABLE");
  const pool = new Pool(resolvePoolOptions(config));
  let initialized = false;

  const ensureReady = async () => {
    if (initialized) {
      return;
    }
    if (config.dbAutoMigrate) {
      const sql = `
        CREATE TABLE IF NOT EXISTS ${table} (
          id BIGSERIAL PRIMARY KEY,
          placa TEXT NOT NULL,
          modulo TEXT,
          resultado JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await pool.query(sql);
    }
    initialized = true;
  };

  const savePlacaResult = async ({ placa, moduleName, resultData }) => {
    const placaValue = String(placa || "").trim();
    if (!placaValue) {
      throw new Error("placa obrigatoria.");
    }

    await ensureReady();

    const payload = JSON.stringify(resultData ?? {});
    const moduloValue = moduleName ? String(moduleName).trim() : null;
    await pool.query(
      `INSERT INTO ${table} (placa, modulo, resultado) VALUES ($1, $2, $3::jsonb)`,
      [placaValue, moduloValue, payload]
    );

    if (debugLog) {
      debugLog("db saved placa result", { placa: placaValue, modulo: moduloValue });
    }
  };

  const getPlacaResult = async (placa) => {
    const placaValue = String(placa || "").trim();
    if (!placaValue) {
      throw new Error("placa obrigatoria.");
    }

    await ensureReady();

    const result = await pool.query(
      `SELECT placa, modulo, resultado, created_at FROM ${table} WHERE placa = $1 ORDER BY created_at DESC LIMIT 1`,
      [placaValue]
    );
    if (!result.rows || result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    let parsed = row.resultado;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch (error) {
        parsed = null;
      }
    }
    return {
      placa: row.placa,
      moduleName: row.modulo || null,
      createdAt: row.created_at || null,
      resultData: parsed,
    };
  };

  const close = async () => {
    await pool.end();
  };

  return {
    savePlacaResult,
    getPlacaResult,
    close,
  };
}

module.exports = {
  createDatabase,
};
