const path = require("path");

const DEFAULT_URL = "https://example.com/";
const DEFAULT_NAV_TIMEOUT_MS = 60000;
const DEFAULT_API_PORT = 3000;
const DEFAULT_CAPTCHA_API_URL = "https://api.2captcha.com/createTask";
const DEFAULT_CAPTCHA_RESULT_URL = "https://api.2captcha.com/getTaskResult";
const DEFAULT_CAPTCHA_WAIT_MS = 2000;
const DEFAULT_CAPTCHA_TEXT = "Resolva o captcha";
const DEFAULT_CHAT_READY_IDLE_MS = 1000;
const DEFAULT_CHAT_OPEN_WAIT_MS = 3000;
const DEFAULT_CHAT_CLICK_RETRIES = 20;
const DEFAULT_CHAT_SCROLL_WAIT_MS = 250;
const DEFAULT_CHAT_SEARCH_WAIT_MS = 300;
const DEFAULT_INPUT_READY_WAIT_MS = 0;
const DEFAULT_INPUT_SET_TIMEOUT_MS = 15000;
const DEFAULT_TYPE_DELAY_MS = 0;
const DEFAULT_CAPTCHA_POLL_MS = 3000;
const DEFAULT_CAPTCHA_POLL_TIMEOUT_MS = 120000;
const DEFAULT_CAPTCHA_UNSOLVABLE_RETRIES = 2;
const DEFAULT_CAPTCHA_CLICK_RETRIES = 3;
const DEFAULT_MODULE_NAME = "BASEDATA";
const DEFAULT_RESULT_BUTTON_LABEL = "RESULTADO";
const DEFAULT_RESULT_WAIT_MS = 30000;
const DEFAULT_OPEN_POPUP_WAIT_MS = 10000;
const DEFAULT_RESULT_PAGE_WAIT_MS = 20000;
const DEFAULT_RESULT_DATA_WAIT_MS = 4000;

function parseNumber(name, value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`${name} must be a number.`);
}

function loadConfig() {
  return {
    targetUrl: process.env.TARGET_URL || DEFAULT_URL,
    headless: process.env.HEADLESS !== "false",
    slowMo: parseNumber("SLOW_MO", process.env.SLOW_MO, 0),
    navTimeoutMs: parseNumber(
      "NAV_TIMEOUT_MS",
      process.env.NAV_TIMEOUT_MS,
      DEFAULT_NAV_TIMEOUT_MS
    ),
    userDataDir: process.env.USER_DATA_DIR || path.join("artifacts", "profile"),
    chatName: process.env.CHAT_NAME || "",
    apiPort: parseNumber("API_PORT", process.env.API_PORT, DEFAULT_API_PORT),
    apiHost: process.env.API_HOST || "0.0.0.0",
    captchaApiKey: process.env.CAPTCHA_API_KEY || "",
    captchaApiUrl: process.env.CAPTCHA_API_URL || DEFAULT_CAPTCHA_API_URL,
    captchaResultUrl: process.env.CAPTCHA_RESULT_URL || DEFAULT_CAPTCHA_RESULT_URL,
    captchaSelector: process.env.CAPTCHA_SELECTOR || "",
    captchaWaitMs: parseNumber(
      "CAPTCHA_WAIT_MS",
      process.env.CAPTCHA_WAIT_MS,
      DEFAULT_CAPTCHA_WAIT_MS
    ),
    captchaPollMs: parseNumber(
      "CAPTCHA_POLL_MS",
      process.env.CAPTCHA_POLL_MS,
      DEFAULT_CAPTCHA_POLL_MS
    ),
    captchaPollTimeoutMs: parseNumber(
      "CAPTCHA_POLL_TIMEOUT_MS",
      process.env.CAPTCHA_POLL_TIMEOUT_MS,
      DEFAULT_CAPTCHA_POLL_TIMEOUT_MS
    ),
    captchaUnsolvableRetries: parseNumber(
      "CAPTCHA_UNSOLVABLE_RETRIES",
      process.env.CAPTCHA_UNSOLVABLE_RETRIES,
      DEFAULT_CAPTCHA_UNSOLVABLE_RETRIES
    ),
    captchaClickRetries: parseNumber(
      "CAPTCHA_CLICK_RETRIES",
      process.env.CAPTCHA_CLICK_RETRIES,
      DEFAULT_CAPTCHA_CLICK_RETRIES
    ),
    moduleName: process.env.MODULE_NAME || DEFAULT_MODULE_NAME,
    resultButtonLabel: process.env.RESULT_BUTTON_LABEL || DEFAULT_RESULT_BUTTON_LABEL,
    resultWaitMs: parseNumber(
      "RESULT_WAIT_MS",
      process.env.RESULT_WAIT_MS,
      DEFAULT_RESULT_WAIT_MS
    ),
    openPopupWaitMs: parseNumber(
      "OPEN_POPUP_WAIT_MS",
      process.env.OPEN_POPUP_WAIT_MS,
      DEFAULT_OPEN_POPUP_WAIT_MS
    ),
    resultPageWaitMs: parseNumber(
      "RESULT_PAGE_WAIT_MS",
      process.env.RESULT_PAGE_WAIT_MS,
      DEFAULT_RESULT_PAGE_WAIT_MS
    ),
    resultDataWaitMs: parseNumber(
      "RESULT_DATA_WAIT_MS",
      process.env.RESULT_DATA_WAIT_MS,
      DEFAULT_RESULT_DATA_WAIT_MS
    ),
    captchaText: process.env.CAPTCHA_TEXT || DEFAULT_CAPTCHA_TEXT,
    chatReadyIdleMs: parseNumber(
      "CHAT_READY_IDLE_MS",
      process.env.CHAT_READY_IDLE_MS,
      DEFAULT_CHAT_READY_IDLE_MS
    ),
    chatOpenWaitMs: parseNumber(
      "CHAT_OPEN_WAIT_MS",
      process.env.CHAT_OPEN_WAIT_MS,
      DEFAULT_CHAT_OPEN_WAIT_MS
    ),
    chatClickRetries: parseNumber(
      "CHAT_CLICK_RETRIES",
      process.env.CHAT_CLICK_RETRIES,
      DEFAULT_CHAT_CLICK_RETRIES
    ),
    chatScrollWaitMs: parseNumber(
      "CHAT_SCROLL_WAIT_MS",
      process.env.CHAT_SCROLL_WAIT_MS,
      DEFAULT_CHAT_SCROLL_WAIT_MS
    ),
    chatSearchWaitMs: parseNumber(
      "CHAT_SEARCH_WAIT_MS",
      process.env.CHAT_SEARCH_WAIT_MS,
      DEFAULT_CHAT_SEARCH_WAIT_MS
    ),
    inputReadyWaitMs: parseNumber(
      "INPUT_READY_WAIT_MS",
      process.env.INPUT_READY_WAIT_MS,
      DEFAULT_INPUT_READY_WAIT_MS
    ),
    inputSetTimeoutMs: parseNumber(
      "INPUT_SET_TIMEOUT_MS",
      process.env.INPUT_SET_TIMEOUT_MS,
      DEFAULT_INPUT_SET_TIMEOUT_MS
    ),
    typeDelayMs: parseNumber(
      "TYPE_DELAY_MS",
      process.env.TYPE_DELAY_MS,
      DEFAULT_TYPE_DELAY_MS
    ),
    debugLogs: String(process.env.DEBUG_LOGS || "").toLowerCase() === "true",
  };
}

module.exports = {
  loadConfig,
  parseNumber,
};
