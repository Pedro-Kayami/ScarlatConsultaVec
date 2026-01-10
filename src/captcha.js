const { postJson } = require("./http");

async function createCaptchaTask(config, imageBase64) {
  if (!config.captchaApiKey) {
    throw new Error("CAPTCHA_API_KEY nao configurada.");
  }

  const payload = {
    clientKey: config.captchaApiKey,
    task: {
      type: "ImageToTextTask",
      body: imageBase64,
      phrase: false,
      case: true,
      numeric: 0,
      math: false,
      minLength: 1,
      maxLength: 5,
      comment: "enter the text you see on the image",
    },
    languagePool: "en",
  };

  const response = await postJson(config.captchaApiUrl, payload);
  if (!response.ok) {
    throw new Error(
      `Erro captcha (${response.status}): ${JSON.stringify(response.json)}`
    );
  }

  return response.json;
}

async function getCaptchaResult(config, taskId) {
  if (!config.captchaApiKey) {
    throw new Error("CAPTCHA_API_KEY nao configurada.");
  }

  const payload = {
    clientKey: config.captchaApiKey,
    taskId,
  };

  const response = await postJson(config.captchaResultUrl, payload);
  if (!response.ok) {
    throw new Error(
      `Erro captcha (${response.status}): ${JSON.stringify(response.json)}`
    );
  }

  return response.json;
}

function buildCaptchaError(message, code, details) {
  const error = new Error(message);
  if (code) {
    error.code = code;
  }
  if (details) {
    error.details = details;
  }
  return error;
}

function isUnsolvableError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "ERROR_CAPTCHA_UNSOLVABLE") {
    return true;
  }
  const details = error.details || {};
  if (details.errorId === 12 || details.errorCode === "ERROR_CAPTCHA_UNSOLVABLE") {
    return true;
  }
  const message = String(error.message || "");
  return message.includes("ERROR_CAPTCHA_UNSOLVABLE");
}

async function solveCaptchaOnce(config, imageBase64, debugLog) {
  const createResponse = await createCaptchaTask(config, imageBase64);
  if (debugLog) {
    debugLog("captcha createTask response", createResponse);
  }

  if (!createResponse || createResponse.errorId !== 0 || !createResponse.taskId) {
    const message =
      createResponse?.errorCode ||
      createResponse?.errorDescription ||
      "Erro ao criar task";
    throw buildCaptchaError(message, createResponse?.errorCode, createResponse);
  }

  const deadline = Date.now() + Math.max(0, config.captchaPollTimeoutMs);
  const pollMs = Math.max(500, config.captchaPollMs);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const result = await getCaptchaResult(config, createResponse.taskId);
    if (debugLog) {
      debugLog("captcha getTaskResult response", result);
    }

    if (result.errorId && result.errorId !== 0) {
      const message = result.errorCode || result.errorDescription || "Erro no resultado";
      throw buildCaptchaError(message, result.errorCode, result);
    }

    if (result.status === "ready") {
      const text = result.solution?.text || "";
      if (!text) {
        throw new Error("Resultado do captcha vazio.");
      }
      return {
        taskId: createResponse.taskId,
        text,
        result,
      };
    }
  }

  throw buildCaptchaError("Timeout aguardando resultado do captcha.", "ERROR_CAPTCHA_TIMEOUT");
}

async function solveCaptcha(config, imageBase64, debugLog) {
  const retries = Math.max(0, config.captchaUnsolvableRetries || 0);
  const maxAttempts = Math.max(1, retries + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (debugLog) {
        debugLog("captcha solve attempt", attempt);
      }
      return await solveCaptchaOnce(config, imageBase64, debugLog);
    } catch (error) {
      lastError = error;
      const canRetry = isUnsolvableError(error) && attempt < maxAttempts;
      if (debugLog) {
        debugLog("captcha solve attempt failed", {
          attempt,
          canRetry,
          error: error?.message || String(error),
        });
      }
      if (!canRetry) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Falha ao resolver captcha.");
}

module.exports = {
  createCaptchaTask,
  solveCaptcha,
};
