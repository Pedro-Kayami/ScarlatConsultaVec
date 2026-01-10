const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { TelegramClient } = require("./telegram");
const { solveCaptcha } = require("./captcha");
const { createServer } = require("./server");
require("dotenv").config();

const config = loadConfig();
const debugLog = createLogger(config.debugLogs);
const telegram = new TelegramClient(config, debugLog);

const app = createServer({ config, telegram, solveCaptcha, debugLog });
const server = app.listen(config.apiPort, config.apiHost, () => {
  console.log(`API pronta em http://${config.apiHost}:${config.apiPort}`);
  console.log(`Abrindo ${config.targetUrl}`);
});

process.on("SIGINT", async () => {
  await telegram.close().catch(() => {});
  server.close(() => {
    process.exit(0);
  });
});
