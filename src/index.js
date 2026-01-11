const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { TelegramClient } = require("./telegram");
const { solveCaptcha } = require("./captcha");
const { createDatabase } = require("./db");
const { createServer } = require("./server");
require("dotenv").config();

const config = loadConfig();
const debugLog = createLogger(config.debugLogs);
const telegram = new TelegramClient(config, debugLog);
const db = createDatabase(config, debugLog);

const app = createServer({ config, telegram, solveCaptcha, debugLog, db });
const server = app.listen(config.apiPort, config.apiHost, () => {
  console.log(`API pronta em http://${config.apiHost}:${config.apiPort}`);
  console.log(`Abrindo ${config.targetUrl}`);
});

const shutdown = async () => {
  await telegram.close().catch(() => {});
  await db.close().catch(() => {});
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
