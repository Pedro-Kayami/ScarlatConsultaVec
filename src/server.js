const fs = require("fs");
const path = require("path");
const express = require("express");

const MAX_PLACA_ATTEMPTS = 3;
const RETRY_WAIT_MS = 1000;

function isNoOptionsError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "no-options") {
    return true;
  }
  const message = String(error.message || "");
  return message.includes("no-options");
}

function cleanupCaptchaImages(debugLog) {
  const dir = path.join("artifacts", "captcha");
  if (!fs.existsSync(dir)) {
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (!name.endsWith(".png")) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, entry.name));
    } catch (error) {
      debugLog("captcha cleanup failed", error.message);
    }
  }
}

function saveCaptchaImage(base64) {
  const dir = path.join("artifacts", "captcha");
  fs.mkdirSync(dir, { recursive: true });
  const safeBase64 = base64.replace(/^data:image\/\w+;base64,/, "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  const filename = `captcha-${timestamp}-${suffix}.png`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, Buffer.from(safeBase64, "base64"));
  return filePath;
}

function createServer({ config, telegram, solveCaptcha, debugLog }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/placa", async (req, res) => {
    const placa = String(req.body?.placa || "").trim();

    if (!placa) {
      return res.status(400).json({ ok: false, error: "placa obrigatoria." });
    }

    try {
      debugLog("placa request", placa);
      const captchaTask = await telegram.runExclusive(async () => {
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_PLACA_ATTEMPTS; attempt += 1) {
          try {
            debugLog("placa attempt", attempt);
            await telegram.sendMessage(`/placa ${placa}`);

            if (!config.captchaApiKey) {
              return null;
            }

        if (config.captchaWaitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.captchaWaitMs));
        }

        const screenshotBase64 = await telegram.captureFullPageWithCaptcha(placa);
        const captchaImagePath = saveCaptchaImage(screenshotBase64);
        console.log("Captcha image saved:", captchaImagePath);
        const maxCaptchaAttempts = Math.max(1, config.captchaClickRetries || 1);
        let solved = null;
        let clickResult = null;
        for (let attempt = 1; attempt <= maxCaptchaAttempts; attempt += 1) {
          debugLog("captcha match attempt", attempt);
          solved = await solveCaptcha(config, screenshotBase64, debugLog);
          console.log("Captcha solved:", solved.text);
          try {
            clickResult = await telegram.clickCaptchaOption(placa, solved.text);
            break;
          } catch (error) {
            const shouldRetry = error?.code === "no-match";
            debugLog("captcha match failed", {
              attempt,
              shouldRetry,
              error: error?.message || String(error),
            });
            if (!shouldRetry || attempt === maxCaptchaAttempts) {
              throw error;
            }
          }
        }
        const moduleResult = await telegram.clickModuleOption(config.moduleName, placa);
        const resultClick = await telegram.clickResultButton(
          config.resultButtonLabel,
              placa,
              config.moduleName
            );
            const openClick = await telegram.clickOpenPopup();
            const resultData = await telegram.extractResultData();
            return {
              solved,
              captchaImagePath,
              clickResult,
              moduleResult,
              resultClick,
              openClick,
              resultData,
            };
          } catch (error) {
            lastError = error;
            const noOptions = isNoOptionsError(error);
            debugLog("placa attempt failed", {
              attempt,
              noOptions,
              error: error?.message || String(error),
            });
            if (!noOptions || attempt === MAX_PLACA_ATTEMPTS) {
              if (noOptions && attempt === MAX_PLACA_ATTEMPTS) {
                await telegram.close().catch(() => {});
              }
              throw error;
            }
            if (RETRY_WAIT_MS > 0) {
              await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
            }
          }
        }

        throw lastError || new Error("Falha ao processar /placa.");
      });

      cleanupCaptchaImages(debugLog);
      return res.json(captchaTask?.resultData || {});
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  return app;
}

module.exports = {
  createServer,
};
