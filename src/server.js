const fs = require("fs");
const path = require("path");
const express = require("express");

const MAX_PLACA_ATTEMPTS = 3;
const RETRY_WAIT_MS = 1000;
const OPEN_POPUP_RETRY_WAIT_MS = 30000;
const RESULT_RETRY_WAIT_MS = 30000;
const MODULE_FALLBACK_NAME = "PRO";

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

function isCaptchaRetryableError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "no-match" || error.code === "no-options") {
    return true;
  }
  return error.code === "module-message-not-found";
}

function isOpenPopupError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "no-popup") {
    return true;
  }
  const message = String(error.message || "");
  return message.includes("no-popup");
}

function isResultRetryableError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "no-match" || error.code === "no-options") {
    return true;
  }
  const message = String(error.message || "");
  return message.includes("clicar no resultado");
}

function normalizeModuleName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function createServer({ config, telegram, solveCaptcha, debugLog, db }) {
  if (!db || typeof db.savePlacaResult !== "function") {
    throw new Error("Banco de dados nao configurado.");
  }
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
      const cached = await db.getPlacaResult(placa);
      if (cached?.resultData) {
        debugLog("placa cache hit", {
          placa,
          modulo: cached.moduleName || null,
          createdAt: cached.createdAt || null,
        });
        return res.json(cached.resultData);
      }

      debugLog("placa request", placa);
      const captchaTask = await telegram.runExclusive(async () => {
        let lastError = null;
        let moduleName = String(config.moduleName || "").trim();
        let sentPlaca = false;

        try {
          for (let attempt = 1; attempt <= MAX_PLACA_ATTEMPTS; attempt += 1) {
            try {
              debugLog("placa attempt", attempt);
              if (!sentPlaca) {
                await telegram.sendMessage(`/placa ${placa}`);
                sentPlaca = true;
              }

              if (!config.captchaApiKey) {
                return null;
              }

              const maxCaptchaAttempts = Math.max(1, config.captchaClickRetries || 1);
              let solved = null;
              let clickResult = null;
              let captchaImagePath = null;
              let moduleResult = null;
              for (let attempt = 1; attempt <= maxCaptchaAttempts; attempt += 1) {
                debugLog("captcha match attempt", attempt);
                if (config.captchaWaitMs > 0) {
                  await new Promise((resolve) => setTimeout(resolve, config.captchaWaitMs));
                }
                const captchaBase64 = await telegram.captureCaptcha(
                  config.captchaSelector,
                  placa
                );
                captchaImagePath = saveCaptchaImage(captchaBase64);
                console.log("Captcha image saved:", captchaImagePath);
                solved = await solveCaptcha(config, captchaBase64, debugLog);
                console.log("Captcha solved:", solved.text);
                try {
                  clickResult = await telegram.clickCaptchaOption(placa, solved.text);
                  try {
                    moduleResult = await telegram.clickModuleOption(moduleName, placa);
                    const notFound = await telegram.waitForModuleNotFound(placa);
                    if (notFound) {
                      if (normalizeModuleName(moduleName) === "basedata") {
                        debugLog("module not found, retrying with PRO");
                        moduleName = MODULE_FALLBACK_NAME;
                        sentPlaca = false;
                        continue;
                      }
                      debugLog("module not found on PRO, ending placa", { placa });
                      const resultData = {
                        ok: false,
                        error: "nao_encontrado",
                        placa,
                        moduleName,
                      };
                      await db.savePlacaResult({
                        placa,
                        moduleName,
                        resultData,
                      });
                      return {
                        solved,
                        captchaImagePath,
                        clickResult,
                        moduleResult,
                        resultData,
                      };
                    }
                  } catch (error) {
                    const shouldRetry = isCaptchaRetryableError(error);
                    debugLog("captcha match failed", {
                      attempt,
                      shouldRetry,
                      error: error?.message || String(error),
                    });
                    if (!shouldRetry || attempt === maxCaptchaAttempts) {
                      throw error;
                    }
                    continue;
                  }
                  break;
                } catch (error) {
                  const shouldRetry = isCaptchaRetryableError(error);
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
              let resultClick = null;
              try {
                resultClick = await telegram.clickResultButton(
                  config.resultButtonLabel,
                  placa,
                  moduleName
                );
              } catch (error) {
                if (
                  isResultRetryableError(error) &&
                  normalizeModuleName(moduleName) !== "pro"
                ) {
                  debugLog("result button not found, retrying with PRO", { placa });
                  if (RESULT_RETRY_WAIT_MS > 0) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, RESULT_RETRY_WAIT_MS)
                    );
                  }
                  moduleName = MODULE_FALLBACK_NAME;
                  sentPlaca = false;
                  continue;
                }
                throw error;
              }
              let openClick = null;
              try {
                openClick = await telegram.clickOpenPopup();
              } catch (error) {
                if (
                  isOpenPopupError(error) &&
                  normalizeModuleName(moduleName) !== "pro"
                ) {
                  debugLog("open popup not found, retrying with PRO", { placa });
                  if (OPEN_POPUP_RETRY_WAIT_MS > 0) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, OPEN_POPUP_RETRY_WAIT_MS)
                    );
                  }
                  moduleName = MODULE_FALLBACK_NAME;
                  sentPlaca = false;
                  continue;
                }
                throw error;
              }
              const resultData = await telegram.extractResultData();
              await db.savePlacaResult({
                placa,
                moduleName,
                resultData,
              });
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
                throw error;
              }
              if (RETRY_WAIT_MS > 0) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
              }
            }
          }

          throw lastError || new Error("Falha ao processar /placa.");
        } finally {
          await telegram.close().catch(() => {});
        }
      });

      return res.json(captchaTask?.resultData || {});
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    } finally {
      cleanupCaptchaImages(debugLog);
    }
  });

  return app;
}

module.exports = {
  createServer,
};
