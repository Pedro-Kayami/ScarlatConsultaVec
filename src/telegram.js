const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const CHAT_SELECTOR = "a.chatlist-chat, a.ListItem-button";
const CHAT_TITLE_SELECTOR = "div.row-title span.peer-title, h3.fullName";
const CHAT_LIST_CONTAINER_SELECTOR = "ul.chatlist, .chat-list";
const CHAT_INPUT_CONTAINER_SELECTOR =
  ".chat-input-container, .input-message-container, .chat-input, .composer, .Composer, " +
  ".message-input-wrapper, #message-input-text";
const CHAT_INPUT_CONTROL_SELECTOR = ".chat-input-control .chat-input-control-button:not(.hide)";
const PRIMARY_INPUT_SELECTOR =
  ".input-message-input[contenteditable='true'][data-peer-id]:not(.input-field-input-fake), " +
  ".input-message-input[contenteditable='true']:not(.input-field-input-fake)";
const FALLBACK_INPUT_SELECTOR =
  ".composer-input[contenteditable='true'], " +
  ".ComposerInput[contenteditable='true'], " +
  ".ComposerTextarea[contenteditable='true'], " +
  ".input-message-container [contenteditable='true'], " +
  ".chat-input [contenteditable='true'], " +
  "#editable-message-text[contenteditable='true'], " +
  "#message-input-text [contenteditable='true'], " +
  ".message-input-wrapper [contenteditable='true']";
const INPUT_SELECTOR = `${PRIMARY_INPUT_SELECTOR}, ${FALLBACK_INPUT_SELECTOR}`;
const QR_CODE_SELECTORS = [
  "canvas.qr-code",
  "canvas.qr-code-canvas",
  "canvas[aria-label*='qr' i]",
  ".qr-code canvas",
  ".qr-code svg",
  "svg.qr-code",
  "svg[aria-label*='qr' i]",
  ".qr-code img",
  "img[alt*='qr' i]",
  "img[src*='qr' i]",
  "#auth-qr-form",
  ".auth-form.qr",
  ".qr-outer",
  ".qr-inner",
  ".qr-container",
  ".qr-code",
];
const QR_CONTAINER_SELECTORS = [
  ".auth-form",
  ".login-form",
  ".auth",
  ".auth-root",
  ".auth-page",
  ".login-page",
];

const PROFILE_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
const PROFILE_LOCK_ERROR_SNIPPETS = [
  "profile appears to be in use",
  "process_singleton",
  "singletonlock",
  "singletonsocket",
  "singletoncookie",
];

function cleanupProfileLocks(userDataDir, debugLog) {
  if (!userDataDir) {
    return;
  }

  const resolved = path.resolve(userDataDir);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (error) {
    if (debugLog) {
      debugLog("profile lock mkdir failed", error.message);
    }
  }

  const targets = [resolved, path.join(resolved, "Default")];
  for (const base of targets) {
    for (const filename of PROFILE_LOCK_FILES) {
      const fullPath = path.join(base, filename);
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      try {
        fs.unlinkSync(fullPath);
        if (debugLog) {
          debugLog("profile lock removed", fullPath);
        }
      } catch (error) {
        if (debugLog) {
          debugLog("profile lock cleanup failed", error.message);
        }
      }
    }
  }
}

function isProfileLockError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (!message) {
    return false;
  }
  return PROFILE_LOCK_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

function buildFallbackProfileDir(userDataDir) {
  const resolved = path.resolve(userDataDir);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return path.join(parent, `${name}-fallback-${timestamp}-${suffix}`);
}

function copyUserDataDir(sourceDir, targetDir, debugLog) {
  try {
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      return false;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: false });
    return true;
  } catch (error) {
    if (debugLog) {
      debugLog("profile copy failed", error.message);
    }
    return false;
  }
}

function saveQrImage(base64, debugLog) {
  const dir = path.join("artifacts", "qr");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    if (debugLog) {
      debugLog("qr mkdir failed", error.message);
    }
  }

  const safeBase64 = String(base64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!safeBase64) {
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  const filename = `qr-${timestamp}-${suffix}.png`;
  const filePath = path.join(dir, filename);
  try {
    fs.writeFileSync(filePath, Buffer.from(safeBase64, "base64"));
  } catch (error) {
    if (debugLog) {
      debugLog("qr write failed", error.message);
    }
    return null;
  }

  return filePath;
}

async function saveLoginScreenshot(page, debugLog) {
  const dir = path.join("artifacts", "qr");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    if (debugLog) {
      debugLog("login screenshot mkdir failed", error.message);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  const filePath = path.join(dir, `login-${timestamp}-${suffix}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
  } catch (error) {
    if (debugLog) {
      debugLog("login screenshot failed", error.message);
    }
    return null;
  }

  return filePath;
}

async function findVisibleElement(page, selectors) {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) {
      continue;
    }
    const box = await handle.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) {
      await handle.dispose().catch(() => {});
      continue;
    }
    return handle;
  }
  return null;
}

class TelegramClient {
  constructor(config, debugLog) {
    this.config = config;
    this.debugLog = debugLog;
    this.state = {
      browser: null,
      page: null,
      opening: null,
      queue: Promise.resolve(),
      loginQrLogged: false,
    };
  }

  runExclusive(task) {
    const next = this.state.queue.then(task, task);
    this.state.queue = next.catch(() => {});
    return next;
  }

  async launchBrowser() {
    this.debugLog("launchBrowser start");
    const launchWithProfile = async (profileDir) => {
      const launchOptions = {
        headless: this.config.headless,
        slowMo: this.config.slowMo,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        ...(profileDir ? { userDataDir: profileDir } : {}),
      };

      const browser = await puppeteer.launch(launchOptions);

      browser.on("disconnected", () => {
        this.state.browser = null;
        this.state.page = null;
      });

      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(this.config.navTimeoutMs);
      await page.goto(this.config.targetUrl, { waitUntil: "networkidle2" });

      this.state.browser = browser;
      this.state.page = page;
      this.debugLog("launchBrowser ready");
      return page;
    };

    const primaryProfile = this.config.userDataDir || "";
    if (this.config.profileLockCleanup && primaryProfile) {
      cleanupProfileLocks(primaryProfile, this.debugLog);
    }

    try {
      return await launchWithProfile(primaryProfile);
    } catch (error) {
      if (
        primaryProfile &&
        this.config.profileFallbackOnLock &&
        isProfileLockError(error)
      ) {
        const fallbackProfile = buildFallbackProfileDir(primaryProfile);
        if (this.config.profileFallbackCopy) {
          copyUserDataDir(primaryProfile, fallbackProfile, this.debugLog);
        } else {
          fs.mkdirSync(fallbackProfile, { recursive: true });
        }
        if (this.config.profileLockCleanup) {
          cleanupProfileLocks(fallbackProfile, this.debugLog);
        }
        this.debugLog("profile lock detected, using fallback profile", fallbackProfile);
        return await launchWithProfile(fallbackProfile);
      }
      throw error;
    }
  }

  async ensurePage() {
    if (this.state.page && !this.state.page.isClosed()) {
      this.debugLog("ensurePage reuse");
      return this.state.page;
    }

    if (!this.state.opening) {
      this.state.opening = this.launchBrowser().finally(() => {
        this.state.opening = null;
      });
    }

    return this.state.opening;
  }

  async waitForLoginQrAndLog(page) {
    if (!this.config.qrLogOnLogin || this.state.loginQrLogged) {
      return false;
    }

    const timeoutMs = Math.max(0, this.config.qrWaitMs || 0);
    if (timeoutMs === 0) {
      return false;
    }

    const selectors = [...QR_CODE_SELECTORS, ...QR_CONTAINER_SELECTORS];
    const selectorQuery = selectors.join(", ");
    const found = await page
      .waitForSelector(selectorQuery, { timeout: timeoutMs, visible: true })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      const screenshot = await saveLoginScreenshot(page, this.debugLog);
      if (screenshot) {
        console.log("LOGIN_SCREENSHOT_FILE=" + screenshot);
      }
      return false;
    }

    const logged = await this.logLoginQr(page);
    if (!logged) {
      const screenshot = await saveLoginScreenshot(page, this.debugLog);
      if (screenshot) {
        console.log("LOGIN_SCREENSHOT_FILE=" + screenshot);
      }
    }
    return logged;
  }

  async logLoginQr(page) {
    if (!this.config.qrLogOnLogin || this.state.loginQrLogged) {
      return false;
    }

    const hasChatList = await page.$("ul.chatlist");
    if (hasChatList) {
      return false;
    }

    let logged = false;
    const screenshotPath = await saveLoginScreenshot(page, this.debugLog);
    if (screenshotPath) {
      console.log("LOGIN_SCREENSHOT_FILE=" + screenshotPath);
      logged = true;
    }

    const qrHandle =
      (await findVisibleElement(page, QR_CODE_SELECTORS)) ||
      (await findVisibleElement(page, QR_CONTAINER_SELECTORS));
    if (!qrHandle) {
      this.debugLog("login qr not found");
      if (logged) {
        this.state.loginQrLogged = true;
      }
      return logged;
    }

    let base64 = null;
    try {
      base64 = await qrHandle.screenshot({ encoding: "base64" });
    } catch (error) {
      this.debugLog("login qr screenshot failed", error.message);
    } finally {
      await qrHandle.dispose().catch(() => {});
    }

    if (!base64) {
      if (logged) {
        this.state.loginQrLogged = true;
      }
      return logged;
    }

    const dataUrl = `data:image/png;base64,${base64}`;
    const filePath = saveQrImage(base64, this.debugLog);
    console.log("QR_CODE_DATA_URL=" + dataUrl);
    if (filePath) {
      console.log("QR_CODE_FILE=" + filePath);
    }
    this.state.loginQrLogged = true;
    return true;
  }

  async waitForChatList(page, timeoutMs) {
    const waitMs = Number.isFinite(timeoutMs)
      ? Math.min(Math.max(0, timeoutMs), this.config.navTimeoutMs)
      : this.config.navTimeoutMs;

    await page.waitForSelector(CHAT_LIST_CONTAINER_SELECTOR, { timeout: waitMs });
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length > 0,
      { timeout: waitMs },
      CHAT_SELECTOR
    );

    const listWaitMs = Math.max(0, this.config.chatListLoginWaitMs || 0);
    if (listWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, listWaitMs));
    }
  }

  async waitForChatCandidate(page, targetName) {
    await page.waitForFunction(
      (selector, titleSelector, name) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const target = normalize(name || "");
        const anchors = document.querySelectorAll(selector);

        for (const anchor of anchors) {
          const titleEl = anchor.querySelector(titleSelector);
          if (!titleEl) {
            continue;
          }
          const title = normalize(titleEl.textContent || "");
          if (title === target || title.includes(target) || target.includes(title)) {
            return true;
          }
        }

        return false;
      },
      { timeout: this.config.navTimeoutMs },
      CHAT_SELECTOR,
      CHAT_TITLE_SELECTOR,
      targetName || ""
    );
  }

  async findChatIndex(page, targetName) {
    return page.$$eval(
      CHAT_SELECTOR,
      (anchors, titleSelector, name) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const target = normalize(name);

        for (let index = 0; index < anchors.length; index += 1) {
          const anchor = anchors[index];
          const titleEl = anchor.querySelector(titleSelector);
          if (!titleEl) {
            continue;
          }
          const title = normalize(titleEl.textContent || "");
          if (title === target || title.includes(target) || target.includes(title)) {
            return index;
          }
        }

        return -1;
      },
      CHAT_TITLE_SELECTOR,
      targetName
    );
  }

  async tryClickChatByName(page, targetName) {
    if (!targetName) {
      return false;
    }
    const index = await this.findChatIndex(page, targetName).catch(() => -1);
    if (index < 0) {
      return false;
    }
    const anchors = await page.$$(CHAT_SELECTOR);
    const anchor = anchors[index];
    if (!anchor) {
      return false;
    }
    await page.evaluate((el) => {
      el.scrollIntoView({ block: "center" });
    }, anchor);
    await anchor.click({ delay: Math.max(0, this.config.typeDelayMs) }).catch(() => {});
    return true;
  }

  async openChat(page) {
    if (!this.config.chatName) {
      return;
    }

    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const target = normalize(this.config.chatName);

    this.debugLog("openChat start", target);
    const preClick = await this.tryClickChatByName(page, target);
    if (preClick) {
      this.debugLog("openChat clicked", target);
      return;
    }
    const graceMs = Math.max(0, this.config.chatListGraceMs || 0);
    if (graceMs > 0) {
      const ready = await this.waitForChatList(page, graceMs)
        .then(() => true)
        .catch(() => false);
      if (!ready) {
        await this.waitForLoginQrAndLog(page);
        await this.waitForChatList(page);
      } else {
        const clicked = await this.tryClickChatByName(page, target);
        if (clicked) {
          this.debugLog("openChat clicked", target);
          return;
        }
      }
    } else {
      try {
        await this.waitForChatList(page);
      } catch (error) {
        await this.waitForLoginQrAndLog(page);
        throw error;
      }
    }
    await page
      .click('input[type="search"], input[placeholder*="Search" i], .search-input input', {
        clickCount: 1,
      })
      .catch(() => {});

    const searchReady = await page.$$eval("input", (inputs) => {
      const match = inputs.find((input) => {
        const placeholder = (input.getAttribute("placeholder") || "").toLowerCase();
        return placeholder.includes("search") || placeholder.includes("buscar");
      });
      if (!match) {
        return false;
      }
      match.focus();
      match.value = "";
      match.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });

    if (searchReady) {
      this.debugLog("openChat search input ready");
      await page.keyboard.type(target, { delay: Math.max(0, this.config.typeDelayMs) });
      await this.waitForChatCandidate(page, target).catch(() => {});
      if (this.config.chatSearchWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.chatSearchWaitMs));
      }
    }

    for (let attempt = 0; attempt < this.config.chatClickRetries; attempt += 1) {
      this.debugLog("openChat attempt", attempt + 1);
      const index = await this.findChatIndex(page, target);
      if (index >= 0) {
        const anchors = await page.$$(CHAT_SELECTOR);
        const anchor = anchors[index];
        if (anchor) {
          await page.evaluate((el) => {
            el.scrollIntoView({ block: "center" });
          }, anchor);
          await anchor.click({ delay: Math.max(0, this.config.typeDelayMs) });
          this.debugLog("openChat clicked", target);
          return;
        }
      }

      const scrolled = await page.evaluate((selector) => {
        const first = document.querySelector(selector);
        if (!first) {
          return false;
        }
        let container = first.parentElement;
        while (container && container.scrollHeight <= container.clientHeight) {
          container = container.parentElement;
        }
        if (!container) {
          return false;
        }
        const before = container.scrollTop;
        const delta = Math.max(200, Math.floor(container.clientHeight * 0.8));
        container.scrollTop = Math.min(container.scrollTop + delta, container.scrollHeight);
        return container.scrollTop !== before;
      }, CHAT_SELECTOR);

      if (!scrolled) {
        break;
      }

      if (this.config.chatScrollWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.chatScrollWaitMs));
      }
    }

    throw new Error(`Chat nao encontrado: ${this.config.chatName}`);
  }

  async isChatActive(page) {
    if (!this.config.chatName) {
      return true;
    }

    return page.evaluate(
      (selector, titleSelector, name, inputSelector) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const target = normalize(name);
        const anchors = document.querySelectorAll(selector);
        let targetPeerId = "";

        for (const anchor of anchors) {
          const titleEl = anchor.querySelector(titleSelector);
          if (!titleEl) {
            continue;
          }
          const title = normalize(titleEl.textContent || "");
          if (!(title === target || title.includes(target) || target.includes(title))) {
            continue;
          }
          targetPeerId = anchor.getAttribute("data-peer-id") || "";
          if (
            anchor.classList.contains("is-selected") ||
            anchor.classList.contains("is-active") ||
            anchor.classList.contains("active") ||
            anchor.getAttribute("aria-selected") === "true"
          ) {
            return true;
          }
        }

        const input = document.querySelector(inputSelector);
        if (input && targetPeerId && input.getAttribute("data-peer-id") === targetPeerId) {
          return true;
        }

        const headerTitle = document.querySelector(
          "header .peer-title, .chat-info .peer-title, .chat-info .title, .chat-title"
        );
        if (headerTitle) {
          const headerText = normalize(headerTitle.textContent || "");
          if (headerText === target || headerText.includes(target) || target.includes(headerText)) {
            return true;
          }
        }

        return false;
      },
      CHAT_SELECTOR,
      CHAT_TITLE_SELECTOR,
      this.config.chatName,
      INPUT_SELECTOR
    );
  }

  async waitForChatActive(page) {
    if (!this.config.chatName) {
      return;
    }

    await page.waitForFunction(
      (selector, titleSelector, name, inputSelector) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const target = normalize(name);
        const anchors = document.querySelectorAll(selector);
        let targetPeerId = "";

        for (const anchor of anchors) {
          const titleEl = anchor.querySelector(titleSelector);
          if (!titleEl) {
            continue;
          }
          const title = normalize(titleEl.textContent || "");
          if (!(title === target || title.includes(target) || target.includes(title))) {
            continue;
          }
          targetPeerId = anchor.getAttribute("data-peer-id") || "";
          if (
            anchor.classList.contains("is-selected") ||
            anchor.classList.contains("is-active") ||
            anchor.classList.contains("active") ||
            anchor.getAttribute("aria-selected") === "true"
          ) {
            return true;
          }
        }

        const input = document.querySelector(inputSelector);
        if (input && targetPeerId && input.getAttribute("data-peer-id") === targetPeerId) {
          return true;
        }

        const headerTitle = document.querySelector(
          "header .peer-title, .chat-info .peer-title, .chat-info .title, .chat-title"
        );
        if (headerTitle) {
          const headerText = normalize(headerTitle.textContent || "");
          if (headerText === target || headerText.includes(target) || target.includes(headerText)) {
            return true;
          }
        }

        return false;
      },
      { timeout: this.config.navTimeoutMs },
      CHAT_SELECTOR,
      CHAT_TITLE_SELECTOR,
      this.config.chatName,
      INPUT_SELECTOR
    );
  }

  async waitForChatReady(page) {
    this.debugLog("waitForChatReady start");
    const timeoutMs = Math.min(this.config.navTimeoutMs, 10000);
    const ready = await page
      .waitForSelector(INPUT_SELECTOR, { timeout: timeoutMs, visible: true })
      .then(() => true)
      .catch(() => false);

    if (!ready) {
      this.debugLog("waitForChatReady timeout");
      return;
    }

    const idleMs = Math.max(0, this.config.chatReadyIdleMs);
    if (idleMs === 0) {
      this.debugLog("waitForChatReady done");
      return;
    }

    if (typeof page.waitForNetworkIdle === "function") {
      await page.waitForNetworkIdle({ idleTime: idleMs, timeout: timeoutMs });
    } else {
      await new Promise((resolve) => setTimeout(resolve, idleMs));
    }
    this.debugLog("waitForChatReady done");
  }

  async ensureChatOpen(page) {
    if (!this.config.chatName) {
      return;
    }

    const alreadyActive = await this.isChatActive(page);
    this.debugLog("ensureChatOpen active", alreadyActive);

    if (!alreadyActive) {
      await this.openChat(page);
      const activeTimeout = Math.max(1000, this.config.chatOpenWaitMs);
      await Promise.race([
        this.waitForChatActive(page).catch((error) => {
          this.debugLog("waitForChatActive timeout", error.message);
        }),
        new Promise((resolve) => setTimeout(resolve, activeTimeout)),
      ]);
      if (this.config.chatOpenWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.chatOpenWaitMs));
      }
    }

    this.debugLog("ensureChatOpen skip waitForChatReady");
    if (!this.config.headless) {
      await page.bringToFront().catch(() => {});
    }
  }

  async forceInputText(page, text) {
    return page.evaluate((primarySelector, fallbackSelector, value) => {
      const dispatchClick = (el) => {
        const rect = el.getBoundingClientRect();
        const options = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          buttons: 1,
        };

        if (typeof PointerEvent === "function") {
          el.dispatchEvent(new PointerEvent("pointerdown", options));
          el.dispatchEvent(new PointerEvent("pointerup", options));
        }
        el.dispatchEvent(new MouseEvent("mousedown", options));
        el.dispatchEvent(new MouseEvent("mouseup", options));
        el.dispatchEvent(new MouseEvent("click", options));
      };

      const candidates = [];
      if (primarySelector) {
        candidates.push(...document.querySelectorAll(primarySelector));
      }
      if (fallbackSelector) {
        candidates.push(...document.querySelectorAll(fallbackSelector));
      }
      if (candidates.length === 0) {
        return false;
      }

      const isVisible = (input) => {
        const rect = input.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }
        const style = window.getComputedStyle(input);
        if (!style) {
          return true;
        }
        return style.display !== "none" && style.visibility !== "hidden";
      };

      const visible = candidates.filter((input) => isVisible(input));
      const input =
        visible.find((item) => item.hasAttribute("data-peer-id")) || visible[0];
      if (!input) {
        return false;
      }

      input.scrollIntoView({ block: "center" });
      dispatchClick(input);
      input.focus();
      input.textContent = value;
      if (input.classList.contains("is-empty")) {
        input.classList.remove("is-empty");
      }
      const container = input.closest(".input-message-container");
      if (container) {
        const placeholder = container.querySelector(".input-field-placeholder");
        if (placeholder) {
          placeholder.classList.remove("is-empty");
        }
      }

      const inputEvent =
        typeof InputEvent === "function"
          ? new InputEvent("input", {
              bubbles: true,
              data: value,
              inputType: "insertText",
            })
          : new Event("input", { bubbles: true });
      input.dispatchEvent(inputEvent);
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const current = (input.textContent || "").trim();
      return current.includes(String(value).trim());
    }, PRIMARY_INPUT_SELECTOR, FALLBACK_INPUT_SELECTOR, text);
  }

  async tryInsertMessage(page, text) {
    await page
      .waitForSelector(CHAT_INPUT_CONTAINER_SELECTOR, {
        timeout: this.config.navTimeoutMs,
      })
      .catch(() => {});

    return page.evaluate(
      (controlSelector, primarySelector, fallbackSelector, value) => {
        const dispatchClick = (el) => {
          const rect = el.getBoundingClientRect();
          const options = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            buttons: 1,
          };

          if (typeof PointerEvent === "function") {
            el.dispatchEvent(new PointerEvent("pointerdown", options));
            el.dispatchEvent(new PointerEvent("pointerup", options));
          }
          el.dispatchEvent(new MouseEvent("mousedown", options));
          el.dispatchEvent(new MouseEvent("mouseup", options));
          el.dispatchEvent(new MouseEvent("click", options));
        };

        const candidates = [];
        if (primarySelector) {
          candidates.push(...document.querySelectorAll(primarySelector));
        }
        if (fallbackSelector) {
          candidates.push(...document.querySelectorAll(fallbackSelector));
        }
        const isVisible = (node) => {
          if (!node) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (!style) {
            return true;
          }
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const el =
          candidates.find((node) => isVisible(node) && node.hasAttribute("data-peer-id")) ||
          candidates.find((node) => isVisible(node)) ||
          candidates[0];

        if (!el) {
          const control = document.querySelector(controlSelector);
          if (control) {
            const rect = control.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              control.scrollIntoView({ block: "center" });
              control.click();
              return { ok: false, reason: "control-clicked" };
            }
          }
          return { ok: false, reason: "no-input" };
        }

        el.scrollIntoView({ block: "center" });
        dispatchClick(el);
        el.focus();
        el.innerHTML = "";
        el.textContent = value;
        if (el.classList.contains("is-empty")) {
          el.classList.remove("is-empty");
        }
        const container = el.closest(".input-message-container");
        const placeholder = container?.querySelector(".input-field-placeholder");
        if (placeholder) {
          placeholder.classList.remove("is-empty");
        }

        const inputEvent =
          typeof InputEvent === "function"
            ? new InputEvent("input", {
                bubbles: true,
                data: value,
                inputType: "insertText",
              })
            : new Event("input", { bubbles: true });
        el.dispatchEvent(inputEvent);
        el.dispatchEvent(new Event("change", { bubbles: true }));

        const current = (el.textContent || "").trim();
        return { ok: current.includes(String(value).trim()) };
      },
      CHAT_INPUT_CONTROL_SELECTOR,
      PRIMARY_INPUT_SELECTOR,
      FALLBACK_INPUT_SELECTOR,
      text
    );
  }

  async clickChatControlIfNeeded(page) {
    const keywords = [
      // "start",
      // "iniciar",
      "começar",
      "unblock",
      "desbloquear",
      "join",
      "open chat",
      "abrir chat",
    ];

    const clicked = await page.evaluate((selector, words) => {
      const buttons = Array.from(document.querySelectorAll(selector));
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const text = (button.textContent || "").trim().toLowerCase();
        if (!text) {
          continue;
        }
        if (words.some((word) => text.includes(word))) {
          button.click();
          return text;
        }
      }
      return "";
    }, CHAT_INPUT_CONTROL_SELECTOR, keywords);

    if (clicked) {
      this.debugLog("chat control clicked", clicked);
      if (this.config.inputReadyWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.inputReadyWaitMs));
      }
      return true;
    }

    return false;
  }

  async waitForControlHidden(page) {
    const timeoutMs = Math.min(this.config.navTimeoutMs, 10000);
    await page
      .waitForFunction(
        (selector) => {
          const buttons = Array.from(document.querySelectorAll(selector));
          return buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width <= 0 || rect.height <= 0;
          });
        },
        { timeout: timeoutMs },
        CHAT_INPUT_CONTROL_SELECTOR
      )
      .catch(() => {});
  }

  async setInputTextWithRetry(page, text) {
    const deadline = Date.now() + Math.max(0, this.config.inputSetTimeoutMs);
    let lastReason = "timeout";
    let waitedForInput = false;

    while (Date.now() < deadline) {
      try {
        const result = await this.tryInsertMessage(page, text);
        this.debugLog("setInputTextWithRetry try", result);
        if (result.ok) {
          return true;
        }
        lastReason = result.reason || "insert-failed";
        if (lastReason === "control-clicked") {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        const forced = await this.forceInputText(page, text);
        if (forced) {
          return true;
        }
      } catch (error) {
        lastReason = error?.message || "insert-failed";
      }

      if (lastReason === "no-input" && !waitedForInput) {
        waitedForInput = true;
        await this.waitForChatReady(page);
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Nao foi possivel inserir texto no chat (${lastReason}).`);
  }

  async sendMessage(text) {
    if (!text) {
      throw new Error("Mensagem vazia.");
    }

    const page = await this.ensurePage();
    await this.ensureChatOpen(page);

    if (!this.config.headless) {
      await page.bringToFront();
    }

    this.debugLog("sendMessage", text);
    const clickedControl = await this.clickChatControlIfNeeded(page);
    if (clickedControl) {
      await this.waitForControlHidden(page);
    }
    this.debugLog("sendMessage skip waitForChatReady");
    await this.setInputTextWithRetry(page, text);
    await page.evaluate((inputSelector) => {
      const input = document.querySelector(inputSelector);
      if (input) {
        input.focus();
      }
    }, INPUT_SELECTOR);
    await page.keyboard.press("Enter");
    this.debugLog("sendMessage enter pressed");
  }

  async captureScreenshotBase64(page, selector) {
    if (selector) {
      await page.waitForSelector(selector, { timeout: this.config.navTimeoutMs });
      const element = await page.$(selector);
      if (!element) {
        throw new Error(`Selector do captcha nao encontrado: ${selector}`);
      }
      return element.screenshot({ encoding: "base64" });
    }

    return page.screenshot({ encoding: "base64" });
  }

  async waitForCaptchaMessage(page, text, placa) {
    await page.waitForFunction(
      (targetText, placaValue) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const target = normalize(targetText);
        const replyTarget = placaValue ? normalize(`/placa ${placaValue}`) : "";

        const getReplyText = (wrapper) => {
          const replySubtitle = wrapper.querySelector(".reply-subtitle");
          if (replySubtitle) {
            return normalize(replySubtitle.textContent || "");
          }
          const embedded = wrapper.querySelector(".message-subheader .embedded-text-wrapper");
          if (embedded) {
            return normalize(embedded.textContent || "");
          }
          const messageText = wrapper.querySelector(".message-subheader .message-text");
          if (messageText) {
            return normalize(messageText.textContent || "");
          }
          const subheader = wrapper.querySelector(".message-subheader");
          if (subheader) {
            return normalize(subheader.textContent || "");
          }
          return "";
        };

        const getMessageText = (wrapper) => {
          const textContent = wrapper.querySelector(".text-content");
          if (textContent) {
            return normalize(textContent.textContent || "");
          }
          const translatable = wrapper.querySelector(".translatable-message");
          if (translatable) {
            return normalize(translatable.textContent || "");
          }
          return normalize(wrapper.textContent || "");
        };

        const isCaptchaImage = (img) => {
          if (!img) {
            return false;
          }
          if (img.closest(".WebPage") || img.closest(".web-page")) {
            return false;
          }
          if (img.closest(".quick-reaction")) {
            return false;
          }
          if (img.classList.contains("ReactionStaticEmoji")) {
            return false;
          }
          if (img.classList.contains("emoji")) {
            return false;
          }
          if (
            img.closest(".text-content") ||
            img.closest(".message-text") ||
            img.closest(".message-subheader") ||
            img.closest(".reply")
          ) {
            return false;
          }
          return true;
        };

        const findCaptchaImage = (wrapper) => {
          const images = wrapper.querySelectorAll(
            "img.media-photo, img.full-media, .attachment img, .media-inner img"
          );
          for (const img of images) {
            if (isCaptchaImage(img)) {
              return img;
            }
          }
          return null;
        };

        const wrapperSelector =
          ".message-content-wrapper, .bubble-content-wrapper, .Message.message-list-item";
        const wrappers = Array.from(document.querySelectorAll(wrapperSelector));
        const candidates =
          wrappers.length > 0
            ? wrappers
            : Array.from(
                document.querySelectorAll("div.message-content, div.bubble-content")
              );

        return candidates.some((wrapper) => {
          const messageText = getMessageText(wrapper);
          const replyText = getReplyText(wrapper);
          const combinedText = `${replyText} ${messageText}`.trim();
          if (replyTarget) {
            if (!replyText.includes(replyTarget)) {
              return false;
            }
          } else if (target && !messageText.includes(target)) {
            return false;
          }
          if (combinedText.includes("/start")) {
            return false;
          }
          if (wrapper.classList?.contains("web-page")) {
            return false;
          }
          if (wrapper.querySelector(".WebPage") || wrapper.querySelector(".web-page")) {
            return false;
          }
          return Boolean(findCaptchaImage(wrapper));
        });
      },
      { timeout: this.config.navTimeoutMs },
      text,
      placa || ""
    );
  }

  async captureCaptchaFromChat(page, placa) {
    if (!this.config.captchaText) {
      throw new Error("CAPTCHA_TEXT nao configurado.");
    }

    await this.waitForCaptchaMessage(page, this.config.captchaText, placa);

    const marked = await page.evaluate((targetText, placaValue) => {
      const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const target = normalize(targetText);
      const replyTarget = placaValue ? normalize(`/placa ${placaValue}`) : "";

      document
        .querySelectorAll("img[data-captcha-target]")
        .forEach((img) => img.removeAttribute("data-captcha-target"));

      const getReplyText = (wrapper) => {
        const replySubtitle = wrapper.querySelector(".reply-subtitle");
        if (replySubtitle) {
          return normalize(replySubtitle.textContent || "");
        }
        const embedded = wrapper.querySelector(".message-subheader .embedded-text-wrapper");
        if (embedded) {
          return normalize(embedded.textContent || "");
        }
        const messageText = wrapper.querySelector(".message-subheader .message-text");
        if (messageText) {
          return normalize(messageText.textContent || "");
        }
        const subheader = wrapper.querySelector(".message-subheader");
        if (subheader) {
          return normalize(subheader.textContent || "");
        }
        return "";
      };

      const getMessageText = (wrapper) => {
        const textContent = wrapper.querySelector(".text-content");
        if (textContent) {
          return normalize(textContent.textContent || "");
        }
        const translatable = wrapper.querySelector(".translatable-message");
        if (translatable) {
          return normalize(translatable.textContent || "");
        }
        return normalize(wrapper.textContent || "");
      };

      const isCaptchaImage = (img) => {
        if (!img) {
          return false;
        }
        if (img.closest(".WebPage") || img.closest(".web-page")) {
          return false;
        }
        if (img.closest(".quick-reaction")) {
          return false;
        }
        if (img.classList.contains("ReactionStaticEmoji")) {
          return false;
        }
        if (img.classList.contains("emoji")) {
          return false;
        }
        if (
          img.closest(".text-content") ||
          img.closest(".message-text") ||
          img.closest(".message-subheader") ||
          img.closest(".reply")
        ) {
          return false;
        }
        return true;
      };

      const findImage = (wrapper) => {
        const images = wrapper.querySelectorAll(
          "img.media-photo, img.full-media, .attachment img, .media-inner img"
        );
        for (const img of images) {
          if (isCaptchaImage(img)) {
            return img;
          }
        }

        return null;
      };

      const wrapperSelector =
        ".message-content-wrapper, .bubble-content-wrapper, .Message.message-list-item";
      const wrappers = Array.from(document.querySelectorAll(wrapperSelector));
      const wrapperCandidates =
        wrappers.length > 0
          ? wrappers
          : Array.from(document.querySelectorAll("div.message-content, div.bubble-content"));
      const candidates = [];
      for (const wrapper of wrapperCandidates) {
        const messageText = getMessageText(wrapper);
        const replyText = getReplyText(wrapper);
        const combinedText = `${replyText} ${messageText}`.trim();
        if (replyTarget) {
          if (!replyText.includes(replyTarget)) {
            continue;
          }
        } else if (target && !messageText.includes(target)) {
            continue;
        }
        if (combinedText.includes("/start")) {
          continue;
        }
        if (wrapper.classList?.contains("web-page")) {
          continue;
        }
        if (wrapper.querySelector(".WebPage") || wrapper.querySelector(".web-page")) {
          continue;
        }

        const img = findImage(wrapper);
        if (!img) {
          continue;
        }
        const rect = wrapper.getBoundingClientRect();
        candidates.push({ img, bottom: rect.bottom });
      }

      if (candidates.length === 0) {
        return false;
      }

      let selected = candidates[0];
      for (let index = 1; index < candidates.length; index += 1) {
        if (candidates[index].bottom >= selected.bottom) {
          selected = candidates[index];
        }
      }

      selected.img.setAttribute("data-captcha-target", "true");
      return true;
    }, this.config.captchaText, placa || "");

    if (!marked) {
      throw new Error("Captcha nao encontrado na conversa.");
    }

    const imageHandle = await page.$("img[data-captcha-target='true']");
    if (!imageHandle) {
      throw new Error("Imagem do captcha nao localizada.");
    }

    await page.evaluate((img) => {
      return new Promise((resolve, reject) => {
        if (img.complete && img.naturalWidth > 0) {
          resolve(true);
          return;
        }

        const onLoad = () => {
          cleanup();
          resolve(true);
        };
        const onError = () => {
          cleanup();
          reject(new Error("Falha ao carregar imagem do captcha."));
        };
        const cleanup = () => {
          img.removeEventListener("load", onLoad);
          img.removeEventListener("error", onError);
        };

        img.addEventListener("load", onLoad);
        img.addEventListener("error", onError);
      });
    }, imageHandle);

    const screenshot = await imageHandle.screenshot({ encoding: "base64" });
    await imageHandle.dispose();
    return screenshot;
  }

  async captureCaptcha(selector, placa) {
    const page = await this.ensurePage();
    await this.ensureChatOpen(page);
    if (selector) {
      return this.captureScreenshotBase64(page, selector);
    }
    return this.captureCaptchaFromChat(page, placa);
  }

  async captureFullPageWithCaptcha(placa) {
    const page = await this.ensurePage();
    await this.ensureChatOpen(page);
    if (this.config.captchaText) {
      await this.waitForCaptchaMessage(page, this.config.captchaText, placa);
    }
    if (this.config.captchaWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.captchaWaitMs));
    }
    return page.screenshot({ encoding: "base64", fullPage: true });
  }

  async waitForCaptchaOptions(page, placa) {
    const timeoutMs = Math.min(this.config.navTimeoutMs, 15000);
    await page.waitForFunction(
      (placaValue) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const replyTarget = placaValue ? normalize(`/placa ${placaValue}`) : "";
        const buttonSelector = ".InlineButtons button, .InlineButtons a, .reply-markup-button";
        const wrapperSelector =
          ".message-content-wrapper, .bubble-content-wrapper, .Message.message-list-item";

        const getReplyText = (wrapper) => {
          const replySubtitle = wrapper.querySelector(".reply-subtitle");
          if (replySubtitle) {
            return normalize(replySubtitle.textContent || "");
          }
          const embedded = wrapper.querySelector(".message-subheader .embedded-text-wrapper");
          if (embedded) {
            return normalize(embedded.textContent || "");
          }
          const messageText = wrapper.querySelector(".message-subheader .message-text");
          if (messageText) {
            return normalize(messageText.textContent || "");
          }
          const subheader = wrapper.querySelector(".message-subheader");
          if (subheader) {
            return normalize(subheader.textContent || "");
          }
          return "";
        };

      const wrappers = Array.from(document.querySelectorAll(wrapperSelector));
      const getButtonsForWrapper = (wrapper) => {
        if (!wrapper) {
          return [];
        }
        const container =
          wrapper.closest(".Message.message-list-item, .message, .message-list-item") ||
          wrapper.parentElement;
        if (container) {
          const buttons = container.querySelectorAll(buttonSelector);
          if (buttons.length > 0) {
            return Array.from(buttons);
          }
        }
        const directButtons = wrapper.querySelectorAll(buttonSelector);
        if (directButtons.length > 0) {
          return Array.from(directButtons);
        }
        return [];
      };

      if (replyTarget) {
        if (wrappers.length > 0) {
          return wrappers.some((wrapper) => {
            const replyText = getReplyText(wrapper);
            if (!replyText.includes(replyTarget)) {
              return false;
            }
            return getButtonsForWrapper(wrapper).length > 0;
          });
        }

        const replyNodes = Array.from(
          document.querySelectorAll(
            ".reply-subtitle, .message-subheader .embedded-text-wrapper, " +
              ".message-subheader .message-text, .message-subheader"
          )
        );
        return replyNodes.some((node) => {
          const replyText = normalize(node.textContent || "");
          if (!replyText.includes(replyTarget)) {
            return false;
          }
          const container =
            node.closest(".Message.message-list-item, .message, .message-list-item") ||
            node.closest(wrapperSelector);
          if (!container) {
            return false;
          }
          const buttons = container.querySelectorAll(buttonSelector);
          return buttons.length > 0;
        });
      }

        return document.querySelectorAll(buttonSelector).length > 0;
      },
      { timeout: timeoutMs },
      placa || ""
    );
  }

  async clickCaptchaOption(placa, text) {
    if (!text) {
      throw new Error("Captcha vazio.");
    }

    const page = await this.ensurePage();
    await this.ensureChatOpen(page);
    await this.waitForCaptchaOptions(page, placa).catch(() => {});

    const result = await page.evaluate((placaValue, value) => {
      const normalize = (input) =>
        String(input || "")
          .replace(/\s+/g, "")
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase();

      const countMatchingLetters = (a, b) => {
        const countChars = (value) => {
          const counts = new Map();
          for (const ch of Array.from(value)) {
            counts.set(ch, (counts.get(ch) || 0) + 1);
          }
          return counts;
        };
        const aCounts = countChars(a);
        const bCounts = countChars(b);
        let score = 0;
        for (const [ch, aCount] of aCounts.entries()) {
          const bCount = bCounts.get(ch) || 0;
          score += Math.min(aCount, bCount);
        }
        return score;
      };

      const target = normalize(value);
      if (!target) {
        return { clicked: false, reason: "empty-target" };
      }

      const normalizeReply = (input) =>
        String(input || "").replace(/\s+/g, " ").trim().toLowerCase();
      const replyTarget = placaValue ? normalizeReply(`/placa ${placaValue}`) : "";
      const buttonSelector = ".InlineButtons button, .InlineButtons a, .reply-markup-button";

      const wrapperSelector =
        ".message-content-wrapper, .bubble-content-wrapper, .Message.message-list-item";

      const getReplyText = (wrapper) => {
        const replySubtitle = wrapper.querySelector(".reply-subtitle");
        if (replySubtitle) {
          return normalizeReply(replySubtitle.textContent || "");
        }
        const embedded = wrapper.querySelector(".message-subheader .embedded-text-wrapper");
        if (embedded) {
          return normalizeReply(embedded.textContent || "");
        }
        const messageText = wrapper.querySelector(".message-subheader .message-text");
        if (messageText) {
          return normalizeReply(messageText.textContent || "");
        }
        const subheader = wrapper.querySelector(".message-subheader");
        if (subheader) {
          return normalizeReply(subheader.textContent || "");
        }
        return "";
      };

      const candidates = [];
      const getButtonsForWrapper = (wrapper) => {
        if (!wrapper) {
          return [];
        }
        const container =
          wrapper.closest(".Message.message-list-item, .message, .message-list-item") ||
          wrapper.parentElement;
        if (container) {
          const buttons = container.querySelectorAll(buttonSelector);
          if (buttons.length > 0) {
            return Array.from(buttons);
          }
        }
        const directButtons = wrapper.querySelectorAll(buttonSelector);
        if (directButtons.length > 0) {
          return Array.from(directButtons);
        }
        return [];
      };
      const wrappers = Array.from(document.querySelectorAll(wrapperSelector));
      if (wrappers.length > 0) {
        for (const wrapper of wrappers) {
          const replyText = getReplyText(wrapper);
          if (replyTarget && !replyText.includes(replyTarget)) {
            continue;
          }
          const buttons = getButtonsForWrapper(wrapper);
          if (buttons.length > 0) {
            const rect = wrapper.getBoundingClientRect();
            candidates.push({ buttons, bottom: rect.bottom });
          }
        }
      } else if (replyTarget) {
        const replyNodes = Array.from(
          document.querySelectorAll(
            ".reply-subtitle, .message-subheader .embedded-text-wrapper, " +
              ".message-subheader .message-text, .message-subheader"
          )
        );
        for (const node of replyNodes) {
          const replyText = normalizeReply(node.textContent || "");
          if (!replyText.includes(replyTarget)) {
            continue;
          }
          const container =
            node.closest(".Message.message-list-item, .message, .message-list-item") ||
            node.closest(wrapperSelector);
          if (!container) {
            continue;
          }
          const buttons = container.querySelectorAll(buttonSelector);
          if (buttons.length > 0) {
            const rect = container.getBoundingClientRect();
            candidates.push({ buttons: Array.from(buttons), bottom: rect.bottom });
          }
        }
      }

      let options = [];
      if (candidates.length > 0) {
        let selected = candidates[0];
        for (let index = 1; index < candidates.length; index += 1) {
          if (candidates[index].bottom >= selected.bottom) {
            selected = candidates[index];
          }
        }
        options = selected.buttons;
      } else if (!replyTarget) {
        options = Array.from(document.querySelectorAll(buttonSelector));
      }

      if (options.length === 0) {
        return { clicked: false, reason: "no-options" };
      }

      const triggerClick = (button) => {
        const rect = button.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          button.scrollIntoView({ block: "center" });
        }
        const options = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          buttons: 1,
        };
        if (typeof PointerEvent === "function") {
          button.dispatchEvent(new PointerEvent("pointerdown", options));
          button.dispatchEvent(new PointerEvent("pointerup", options));
        }
        button.dispatchEvent(new MouseEvent("mousedown", options));
        button.dispatchEvent(new MouseEvent("mouseup", options));
        button.dispatchEvent(new MouseEvent("click", options));
      };

      document
        .querySelectorAll("[data-captcha-choice]")
        .forEach((node) => node.removeAttribute("data-captcha-choice"));

      const mapped = options
        .map((button) => {
          const textEl =
            button.querySelector(".inline-button-text") ||
            button.querySelector(".reply-markup-button-text");
          const label = textEl ? textEl.textContent || "" : button.textContent || "";
          const norm = normalize(label);
          return { button, label, norm };
        })
        .filter((entry) => entry.norm);

      for (const entry of mapped) {
        if (entry.norm === target) {
          triggerClick(entry.button);
          entry.button.setAttribute("data-captcha-choice", "true");
          return { clicked: true, match: "exact", label: entry.label };
        }
      }

      let best = null;
      for (const entry of mapped) {
        const score = countMatchingLetters(target, entry.norm);
        if (!best || score > best.score) {
          best = { entry, score };
        }
      }

      if (best && best.score > 0) {
        triggerClick(best.entry.button);
        best.entry.button.setAttribute("data-captcha-choice", "true");
        return { clicked: true, match: "letters", label: best.entry.label, score: best.score };
      }

      return {
        clicked: false,
        reason: "no-match",
        target,
        options: mapped.map((entry) => entry.label),
      };
    }, placa || "", text);

    if (result.clicked) {
      const handle = await page.$("[data-captcha-choice='true']");
      if (handle) {
        try {
          const box = await handle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
          await handle.click().catch(() => {});
        } finally {
          await handle.evaluate((el) => el.removeAttribute("data-captcha-choice")).catch(() => {});
          await handle.dispose().catch(() => {});
        }
      }
    }

    this.debugLog("captcha option click result", result);
    if (!result.clicked) {
      const error = new Error(`Nao foi possivel clicar no captcha (${result.reason}).`);
      error.code = result.reason;
      error.details = result;
      throw error;
    }
    return result;
  }

  async waitForModuleOptions(page, label, placa) {
    if (!label) {
      return;
    }

    const timeoutMs = Math.min(this.config.navTimeoutMs, 20000);
    await page.waitForFunction(
      (labelValue, placaValue) => {
        const normalize = (input) =>
          String(input || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const target = normalize(labelValue);
        const placaTarget = normalize(placaValue || "");

        const containsPlaca = (text) => {
          if (!text.includes("placa")) {
            return false;
          }
          if (!placaTarget) {
            return true;
          }
          return text.includes(placaTarget);
        };

        const isModuleMessage = (text) =>
          text.includes("selecione") && text.includes("modulo");

        const matchLabel = (text) => normalize(text).includes(target);

        const messageNodes = Array.from(document.querySelectorAll(".Message.message-list-item"));
        if (messageNodes.length > 0) {
          let startIndex = 0;
          for (let index = messageNodes.length - 1; index >= 0; index -= 1) {
            const messageText = normalize(
              messageNodes[index].querySelector(".text-content")?.textContent ||
                messageNodes[index].textContent ||
                ""
            );
            if (containsPlaca(messageText)) {
              startIndex = index + 1;
              break;
            }
          }

          for (let index = startIndex; index < messageNodes.length; index += 1) {
            const message = messageNodes[index];
            const messageText = normalize(
              message.querySelector(".text-content")?.textContent ||
                message.textContent ||
                ""
            );
            if (!isModuleMessage(messageText)) {
              continue;
            }
            const buttons = Array.from(
              message.querySelectorAll(
                ".InlineButtons button, .InlineButtons a, .reply-markup-button"
              )
            );
            for (const button of buttons) {
              const labelEl =
                button.querySelector(".inline-button-text") ||
                button.querySelector(".reply-markup-button-text") ||
                button;
              if (matchLabel(labelEl.textContent || "")) {
                return true;
              }
            }
          }
        }

        const wrappers = Array.from(document.querySelectorAll("div.bubble-content-wrapper"));
        let startIndex = 0;
        for (let index = wrappers.length - 1; index >= 0; index -= 1) {
          const messageText = normalize(wrappers[index].textContent || "");
          if (containsPlaca(messageText)) {
            startIndex = index + 1;
            break;
          }
        }

        for (let index = startIndex; index < wrappers.length; index += 1) {
          const wrapper = wrappers[index];
          const messageText = normalize(wrapper.textContent || "");
          if (!isModuleMessage(messageText)) {
            continue;
          }
          const buttons = wrapper.querySelectorAll(".reply-markup-button");
          for (const button of buttons) {
            const labelEl =
              button.querySelector(".reply-markup-button-text") ||
              button.querySelector(".inline-button-text") ||
              button;
            if (matchLabel(labelEl.textContent || "")) {
              return true;
            }
          }
        }

        return false;
      },
      { timeout: timeoutMs },
      label,
      placa || ""
    );
  }

  async waitForModuleNotFound(placa) {
    const page = await this.ensurePage();
    await this.ensureChatOpen(page);
    const timeoutMs = Math.min(this.config.navTimeoutMs, 8000);

    return page
      .waitForFunction(
        (placaValue) => {
          const normalize = (input) =>
            String(input || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();

          const targetText = normalize("nao encontrado");
          const placaTarget = normalize(placaValue || "");
          const isModuleMessage = (text) =>
            text.includes("selecione") && text.includes("modulo");

          const getReplyText = (node) => {
            const replySubtitle = node.querySelector(".reply-subtitle");
            if (replySubtitle) {
              return normalize(replySubtitle.textContent || "");
            }
            const embedded = node.querySelector(".message-subheader .embedded-text-wrapper");
            if (embedded) {
              return normalize(embedded.textContent || "");
            }
            const messageText = node.querySelector(".message-subheader .message-text");
            if (messageText) {
              return normalize(messageText.textContent || "");
            }
            const subheader = node.querySelector(".message-subheader");
            if (subheader) {
              return normalize(subheader.textContent || "");
            }
            return "";
          };

          const getMessageText = (node) => {
            const textContent = node.querySelector(".text-content");
            if (textContent) {
              return normalize(textContent.textContent || "");
            }
            const translatable = node.querySelector(".translatable-message");
            if (translatable) {
              return normalize(translatable.textContent || "");
            }
            return normalize(node.textContent || "");
          };

          const findNotFoundAfter = (nodes) => {
            let startIndex = -1;
            for (let index = nodes.length - 1; index >= 0; index -= 1) {
              const node = nodes[index];
              const combined = `${getReplyText(node)} ${getMessageText(node)}`.trim();
              if (combined.includes("/placa")) {
                if (!placaTarget || combined.includes(placaTarget)) {
                  startIndex = index + 1;
                  break;
                }
              }
              if (isModuleMessage(combined)) {
                startIndex = index + 1;
                break;
              }
            }

            const begin = startIndex >= 0 ? startIndex : 0;
            for (let index = begin; index < nodes.length; index += 1) {
              const node = nodes[index];
              const combined = `${getReplyText(node)} ${getMessageText(node)}`.trim();
              if (combined.includes(targetText)) {
                return true;
              }
            }
            return false;
          };

          const messageNodes = Array.from(
            document.querySelectorAll(".Message.message-list-item")
          );
          if (messageNodes.length > 0) {
            return findNotFoundAfter(messageNodes);
          }

          const wrappers = Array.from(document.querySelectorAll("div.bubble-content-wrapper"));
          if (wrappers.length > 0) {
            return findNotFoundAfter(wrappers);
          }

          const fallbacks = Array.from(
            document.querySelectorAll("div.message-content, div.bubble-content")
          );
          return findNotFoundAfter(fallbacks);
        },
        { timeout: timeoutMs },
        placa || ""
      )
      .then(() => true)
      .catch(() => false);
  }

  async clickModuleOption(label, placa) {
    if (!label) {
      return null;
    }

    const page = await this.ensurePage();
    await this.ensureChatOpen(page);
    await this.waitForModuleOptions(page, label, placa).catch(() => {});

    const result = await page.evaluate((labelValue, placaValue) => {
      const normalize = (input) =>
        String(input || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const target = normalize(labelValue);
      const placaTarget = normalize(placaValue || "");

      const containsPlaca = (text) => {
        if (!text.includes("placa")) {
          return false;
        }
        if (!placaTarget) {
          return true;
        }
        return text.includes(placaTarget);
      };

      const isModuleMessage = (text) =>
        text.includes("selecione") && text.includes("modulo");

      const matchLabel = (text) => normalize(text).includes(target);

      const triggerClick = (button) => {
        const rect = button.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          button.scrollIntoView({ block: "center" });
        }
        const options = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          buttons: 1,
        };
        if (typeof PointerEvent === "function") {
          button.dispatchEvent(new PointerEvent("pointerdown", options));
          button.dispatchEvent(new PointerEvent("pointerup", options));
        }
        button.dispatchEvent(new MouseEvent("mousedown", options));
        button.dispatchEvent(new MouseEvent("mouseup", options));
        button.dispatchEvent(new MouseEvent("click", options));
      };

      document
        .querySelectorAll("[data-module-choice]")
        .forEach((node) => node.removeAttribute("data-module-choice"));

      const messageNodes = Array.from(document.querySelectorAll(".Message.message-list-item"));
      if (messageNodes.length > 0) {
        let startIndex = 0;
        for (let index = messageNodes.length - 1; index >= 0; index -= 1) {
          const messageText = normalize(
            messageNodes[index].querySelector(".text-content")?.textContent ||
              messageNodes[index].textContent ||
              ""
          );
          if (containsPlaca(messageText)) {
            startIndex = index + 1;
            break;
          }
        }

        let matchedMessage = null;
        for (let index = startIndex; index < messageNodes.length; index += 1) {
          const message = messageNodes[index];
          const messageText = normalize(
            message.querySelector(".text-content")?.textContent ||
              message.textContent ||
              ""
          );
          if (isModuleMessage(messageText)) {
            matchedMessage = message;
          }
        }

        if (matchedMessage) {
          const buttons = Array.from(
            matchedMessage.querySelectorAll(
              ".InlineButtons button, .InlineButtons a, .reply-markup-button"
            )
          );
          const mapped = buttons
            .map((button) => {
              const labelEl =
                button.querySelector(".inline-button-text") ||
                button.querySelector(".reply-markup-button-text") ||
                button;
              const labelText = labelEl ? labelEl.textContent || "" : "";
              const norm = normalize(labelText);
              return { button, label: labelText, norm };
            })
            .filter((entry) => entry.norm);

          for (const entry of mapped) {
            if (entry.norm.includes(target)) {
              triggerClick(entry.button);
              entry.button.setAttribute("data-module-choice", "true");
              return { clicked: true, match: "label", label: entry.label };
            }
          }

          return {
            clicked: false,
            reason: "no-match",
            target,
            options: mapped.map((entry) => entry.label),
          };
        }
      }

      const wrappers = Array.from(document.querySelectorAll("div.bubble-content-wrapper"));
      if (wrappers.length === 0) {
        return { clicked: false, reason: "no-options" };
      }

      let startIndex = 0;
      for (let index = wrappers.length - 1; index >= 0; index -= 1) {
        const messageText = normalize(wrappers[index].textContent || "");
        if (containsPlaca(messageText)) {
          startIndex = index + 1;
          break;
        }
      }

      let matchedWrapper = null;
      for (let index = startIndex; index < wrappers.length; index += 1) {
        const wrapper = wrappers[index];
        const messageText = normalize(wrapper.textContent || "");
        if (isModuleMessage(messageText)) {
          matchedWrapper = wrapper;
        }
      }

      if (!matchedWrapper) {
        return { clicked: false, reason: "module-message-not-found" };
      }

      const buttons = Array.from(
        matchedWrapper.querySelectorAll(
          ".InlineButtons button, .InlineButtons a, .reply-markup-button"
        )
      );
      if (buttons.length === 0) {
        return { clicked: false, reason: "no-options" };
      }

      const mapped = buttons
        .map((button) => {
          const labelEl =
            button.querySelector(".reply-markup-button-text") ||
            button.querySelector(".inline-button-text") ||
            button;
          const labelText = labelEl ? labelEl.textContent || "" : "";
          const norm = normalize(labelText);
          return { button, label: labelText, norm };
        })
        .filter((entry) => entry.norm);

      for (const entry of mapped) {
        if (entry.norm.includes(target)) {
          triggerClick(entry.button);
          entry.button.setAttribute("data-module-choice", "true");
          return { clicked: true, match: "label", label: entry.label };
        }
      }

      return {
        clicked: false,
        reason: "no-match",
        target,
        options: mapped.map((entry) => entry.label),
      };
    }, label, placa || "");

    if (result.clicked) {
      const handle = await page.$("[data-module-choice='true']");
      if (handle) {
        try {
          const box = await handle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
          await handle.click().catch(() => {});
        } finally {
          await handle.evaluate((el) => el.removeAttribute("data-module-choice")).catch(() => {});
          await handle.dispose().catch(() => {});
        }
      }
    }

    this.debugLog("module option click result", result);
    if (!result.clicked) {
      const error = new Error(`Nao foi possivel clicar no modulo (${result.reason}).`);
      error.code = result.reason;
      error.details = result;
      throw error;
    }
    return result;
  }

  async waitForResultButton(page, label, placa, moduleName) {
    if (!label) {
      return;
    }

    const timeoutMs = Math.max(0, this.config.resultWaitMs || 0);
    if (timeoutMs === 0) {
      return;
    }

    await page.waitForFunction(
      (labelValue, placaValue, moduleValue) => {
        const normalize = (input) =>
          String(input || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const target = normalize(labelValue);
        const placaTarget = normalize(placaValue || "");
        const moduleTarget = normalize(moduleValue || "");

        const containsPlaca = (text) => {
          if (!text.includes("/placa")) {
            return false;
          }
          if (!placaTarget) {
            return true;
          }
          return text.includes(placaTarget);
        };

        const matchLabel = (text) => normalize(text).includes(target);

        const messageNodes = Array.from(document.querySelectorAll(".Message.message-list-item"));
        if (messageNodes.length > 0) {
          let startIndex = 0;
          for (let index = messageNodes.length - 1; index >= 0; index -= 1) {
            const messageText = normalize(
              messageNodes[index].querySelector(".text-content")?.textContent ||
                messageNodes[index].textContent ||
                ""
            );
            if (containsPlaca(messageText)) {
              startIndex = index + 1;
              break;
            }
          }

          const hasMatchAfter = (requireModule) => {
            for (let index = startIndex; index < messageNodes.length; index += 1) {
              const message = messageNodes[index];
              if (requireModule && moduleTarget) {
                const messageText = normalize(
                  message.querySelector(".text-content")?.textContent ||
                    message.textContent ||
                    ""
                );
                if (!messageText.includes(moduleTarget)) {
                  continue;
                }
              }
              const buttons = Array.from(
                message.querySelectorAll(".InlineButtons button, .InlineButtons a")
              );
              for (const button of buttons) {
                const labelEl = button.querySelector(".inline-button-text") || button;
                if (matchLabel(labelEl.textContent || "")) {
                  return true;
                }
              }
            }
            return false;
          };

          if (hasMatchAfter(true)) {
            return true;
          }
          if (hasMatchAfter(false)) {
            return true;
          }
          return false;
        }

        const wrappers = Array.from(document.querySelectorAll("div.bubble-content-wrapper"));
        if (wrappers.length === 0) {
          return false;
        }

        let startIndex = 0;
        for (let index = wrappers.length - 1; index >= 0; index -= 1) {
          const messageText = normalize(wrappers[index].textContent || "");
          if (containsPlaca(messageText)) {
            startIndex = index + 1;
            break;
          }
        }

        const hasMatchAfter = (requireModule) => {
          for (let index = startIndex; index < wrappers.length; index += 1) {
            const wrapper = wrappers[index];
            if (requireModule && moduleTarget) {
              const messageText = normalize(wrapper.textContent || "");
              if (!messageText.includes(moduleTarget)) {
                continue;
              }
            }
            const buttons = Array.from(
              wrapper.querySelectorAll(
                ".InlineButtons button, .InlineButtons a, .reply-markup-button"
              )
            );
            for (const button of buttons) {
              const labelEl =
                button.querySelector(".inline-button-text") ||
                button.querySelector(".reply-markup-button-text") ||
                button;
              if (matchLabel(labelEl.textContent || "")) {
                return true;
              }
            }
          }
          return false;
        };

        if (hasMatchAfter(true)) {
          return true;
        }
        return hasMatchAfter(false);
      },
      { timeout: timeoutMs },
      label,
      placa || "",
      moduleName || ""
    );
  }

  async clickResultButton(label, placa, moduleName) {
    if (!label) {
      return null;
    }

    const page = await this.ensurePage();
    await this.ensureChatOpen(page);
    await this.waitForResultButton(page, label, placa, moduleName).catch(() => {});

    const result = await page.evaluate((labelValue, placaValue, moduleValue) => {
      const normalize = (input) =>
        String(input || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const target = normalize(labelValue);
      const placaTarget = normalize(placaValue || "");
      const moduleTarget = normalize(moduleValue || "");

      if (!target) {
        return { clicked: false, reason: "empty-target" };
      }

      const containsPlaca = (text) => {
        if (!text.includes("/placa")) {
          return false;
        }
        if (!placaTarget) {
          return true;
        }
        return text.includes(placaTarget);
      };

      const matchLabel = (text) => normalize(text).includes(target);

      const triggerClick = (button) => {
        const rect = button.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          button.scrollIntoView({ block: "center" });
        }
        const options = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          buttons: 1,
        };
        if (typeof PointerEvent === "function") {
          button.dispatchEvent(new PointerEvent("pointerdown", options));
          button.dispatchEvent(new PointerEvent("pointerup", options));
        }
        button.dispatchEvent(new MouseEvent("mousedown", options));
        button.dispatchEvent(new MouseEvent("mouseup", options));
        button.dispatchEvent(new MouseEvent("click", options));
      };

      document
        .querySelectorAll("[data-result-choice]")
        .forEach((node) => node.removeAttribute("data-result-choice"));

      const messageNodes = Array.from(document.querySelectorAll(".Message.message-list-item"));
      if (messageNodes.length > 0) {
        let startIndex = 0;
        for (let index = messageNodes.length - 1; index >= 0; index -= 1) {
          const messageText = normalize(
            messageNodes[index].querySelector(".text-content")?.textContent ||
              messageNodes[index].textContent ||
              ""
          );
          if (containsPlaca(messageText)) {
            startIndex = index + 1;
            break;
          }
        }

        const findButtonAfter = (requireModule) => {
          for (let index = startIndex; index < messageNodes.length; index += 1) {
            const message = messageNodes[index];
            if (requireModule && moduleTarget) {
              const messageText = normalize(
                message.querySelector(".text-content")?.textContent ||
                  message.textContent ||
                  ""
              );
              if (!messageText.includes(moduleTarget)) {
                continue;
              }
            }
            const buttons = Array.from(
              message.querySelectorAll(".InlineButtons button, .InlineButtons a")
            );
            for (const button of buttons) {
              const labelEl = button.querySelector(".inline-button-text") || button;
              if (matchLabel(labelEl.textContent || "")) {
                return button;
              }
            }
          }
          return null;
        };

        let button = findButtonAfter(true);
        if (!button) {
          button = findButtonAfter(false);
        }
        if (button) {
          triggerClick(button);
          button.setAttribute("data-result-choice", "true");
          return { clicked: true, match: "label" };
        }

        return { clicked: false, reason: "no-match" };
      }

      const wrappers = Array.from(document.querySelectorAll("div.bubble-content-wrapper"));
      if (wrappers.length === 0) {
        return { clicked: false, reason: "no-options" };
      }

      let startIndex = 0;
      for (let index = wrappers.length - 1; index >= 0; index -= 1) {
        const messageText = normalize(wrappers[index].textContent || "");
        if (containsPlaca(messageText)) {
          startIndex = index + 1;
          break;
        }
      }

      const findButtonAfter = (requireModule) => {
        for (let index = startIndex; index < wrappers.length; index += 1) {
          const wrapper = wrappers[index];
          if (requireModule && moduleTarget) {
            const messageText = normalize(wrapper.textContent || "");
            if (!messageText.includes(moduleTarget)) {
              continue;
            }
          }
          const buttons = wrapper.querySelectorAll(
            ".InlineButtons button, .InlineButtons a, .reply-markup-button"
          );
          for (const button of buttons) {
            const labelEl =
              button.querySelector(".inline-button-text") ||
              button.querySelector(".reply-markup-button-text") ||
              button;
            if (matchLabel(labelEl.textContent || "")) {
              return button;
            }
          }
        }
        return null;
      };

      let button = findButtonAfter(true);
      if (!button) {
        button = findButtonAfter(false);
      }
      if (button) {
        triggerClick(button);
        button.setAttribute("data-result-choice", "true");
        return { clicked: true, match: "label" };
      }

      return { clicked: false, reason: "no-match" };
    }, label, placa || "", moduleName || "");

    if (result.clicked) {
      const handle = await page.$("[data-result-choice='true']");
      if (handle) {
        try {
          const box = await handle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
          await handle.click().catch(() => {});
        } finally {
          await handle.evaluate((el) => el.removeAttribute("data-result-choice")).catch(() => {});
          await handle.dispose().catch(() => {});
        }
      }
    }

    this.debugLog("result button click result", result);
    if (!result.clicked) {
      const error = new Error(`Nao foi possivel clicar no resultado (${result.reason}).`);
      error.code = result.reason;
      error.details = result;
      throw error;
    }
    return result;
  }

  async waitForOpenPopup(page, labels) {
    const timeoutMs = Math.max(0, this.config.openPopupWaitMs || 0);
    if (timeoutMs === 0) {
      return;
    }

    await page.waitForFunction(
      (labelValues) => {
        const normalize = (input) =>
          String(input || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const targets = (labelValues || []).map((label) => normalize(label));
        if (targets.length === 0) {
          return false;
        }

        const buttons = Array.from(
          document.querySelectorAll(
            ".popup-container .popup-button, .popup-buttons .popup-button, " +
              ".modal-dialog .confirm-dialog-button, .modal-dialog button"
          )
        );
        return buttons.some((button) => {
          const rect = button.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }
          const text = normalize(button.textContent || "");
          return targets.some((label) => text.includes(label));
        });
      },
      { timeout: timeoutMs },
      labels
    );
  }

  async clickOpenPopup() {
    const page = await this.ensurePage();
    const labels = ["open", "abrir"];
    await this.waitForOpenPopup(page, labels).catch(() => {});

    const result = await page.evaluate((labelValues) => {
      const normalize = (input) =>
        String(input || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const targets = (labelValues || []).map((label) => normalize(label));
      if (targets.length === 0) {
        return { clicked: false, reason: "empty-target" };
      }

      const triggerClick = (button) => {
        const rect = button.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          button.scrollIntoView({ block: "center" });
        }
        const options = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          buttons: 1,
        };
        if (typeof PointerEvent === "function") {
          button.dispatchEvent(new PointerEvent("pointerdown", options));
          button.dispatchEvent(new PointerEvent("pointerup", options));
        }
        button.dispatchEvent(new MouseEvent("mousedown", options));
        button.dispatchEvent(new MouseEvent("mouseup", options));
        button.dispatchEvent(new MouseEvent("click", options));
      };

      document
        .querySelectorAll("[data-open-choice]")
        .forEach((node) => node.removeAttribute("data-open-choice"));

      const buttons = Array.from(
        document.querySelectorAll(
          ".popup-container .popup-button, .popup-buttons .popup-button, " +
            ".modal-dialog .confirm-dialog-button, .modal-dialog button"
        )
      );
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const text = normalize(button.textContent || "");
        if (targets.some((label) => text.includes(label))) {
          triggerClick(button);
          button.setAttribute("data-open-choice", "true");
          return { clicked: true, match: text };
        }
      }

      return { clicked: false, reason: "no-popup" };
    }, labels);

    if (result.clicked) {
      const handle = await page.$("[data-open-choice='true']");
      if (handle) {
        try {
          const box = await handle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
          await handle.click().catch(() => {});
        } finally {
          await handle.evaluate((el) => el.removeAttribute("data-open-choice")).catch(() => {});
          await handle.dispose().catch(() => {});
        }
      }
    }

    this.debugLog("open popup click result", result);
    if (!result.clicked) {
      const error = new Error(`Nao foi possivel clicar no open (${result.reason}).`);
      error.code = result.reason;
      error.details = result;
      throw error;
    }
    return result;
  }

  async getResultPage() {
    const page = await this.ensurePage();
    const browser = this.state.browser;
    if (!browser) {
      throw new Error("Browser nao iniciado.");
    }

    const timeoutMs = Math.max(0, this.config.resultPageWaitMs || 0);
    const deadline = Date.now() + timeoutMs;
    const selector = "#resultContainer, .result-container";

    const matchesResult = async (candidate) => {
      if (!candidate || candidate.isClosed()) {
        return false;
      }
      const url = candidate.url();
      if (!url || url === "about:blank") {
        return false;
      }
      try {
        return await candidate.evaluate(
          (selectorValue) => Boolean(document.querySelector(selectorValue)),
          selector
        );
      } catch (error) {
        return false;
      }
    };

    if (await matchesResult(page)) {
      return page;
    }

    while (Date.now() < deadline) {
      const pages = await browser.pages();
      for (const candidate of pages) {
        if (await matchesResult(candidate)) {
          candidate.setDefaultNavigationTimeout(this.config.navTimeoutMs);
          await candidate.bringToFront().catch(() => {});
          return candidate;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("Pagina de resultado nao encontrada.");
  }

  async extractResultData() {
    const page = await this.getResultPage();
    const timeoutMs = Math.max(0, this.config.resultPageWaitMs || 0);
    await page.waitForSelector("#resultContainer, .result-container", { timeout: timeoutMs });

    const dataWaitMs = Math.max(0, this.config.resultDataWaitMs || 0);
    if (dataWaitMs > 0) {
      await page
        .waitForFunction(
          () => {
            const loading = document.querySelector("#loadingContainer");
            const loadingVisible =
              loading &&
              loading.offsetParent !== null &&
              window.getComputedStyle(loading).display !== "none";
            const items = document.querySelectorAll(".data-item").length;
            return !loadingVisible && items > 0;
          },
          { timeout: dataWaitMs }
        )
        .catch(() => {});
    }

    const data = await page.evaluate(() => {
      const normalizeText = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const container =
        document.querySelector("#resultContainer, .result-container") ||
        document.querySelector(".container") ||
        document.body;

      const titleEl = container.querySelector(".result-title, #resultTitle");
      const timestampEl = container.querySelector(".result-timestamp, #resultTimestamp");
      const photoEl = container.querySelector("#photoImage, .photo-image");
      const photoSrc = photoEl?.getAttribute("src") || photoEl?.src || "";

      const sections = [];

      const extractItems = (scope) => {
        const items = [];
        scope.querySelectorAll(".data-item").forEach((item) => {
          const labelEl = item.querySelector(".data-label");
          const valueEl = item.querySelector(".data-value");
          const label = normalizeText(labelEl ? labelEl.textContent : "");
          const value = normalizeText(valueEl ? valueEl.textContent : item.textContent || "");
          if (label || value) {
            items.push({ label, value });
          }
        });
        return items;
      };

      const sectionNodes = Array.from(container.querySelectorAll(".data-section"));
      sectionNodes.forEach((section) => {
        const title = normalizeText(section.querySelector(".section-title")?.textContent || "");
        const items = extractItems(section);
        if (title || items.length > 0) {
          sections.push({ title: title || null, items });
        }
      });

      const orphanItems = Array.from(container.querySelectorAll(".data-item")).filter(
        (item) => !item.closest(".data-section")
      );
      if (orphanItems.length > 0) {
        const items = [];
        orphanItems.forEach((item) => {
          const labelEl = item.querySelector(".data-label");
          const valueEl = item.querySelector(".data-value");
          const label = normalizeText(labelEl ? labelEl.textContent : "");
          const value = normalizeText(valueEl ? valueEl.textContent : item.textContent || "");
          if (label || value) {
            items.push({ label, value });
          }
        });
        if (items.length > 0) {
          sections.push({ title: null, items });
        }
      }

      return {
        title: normalizeText(titleEl?.textContent || ""),
        timestamp: normalizeText(timestampEl?.textContent || ""),
        photoUrl: photoSrc || null,
        sections,
      };
    });

    this.debugLog("result data extracted", {
      title: data?.title || "",
      sections: data?.sections?.length || 0,
    });
    return data;
  }

  async close() {
    if (this.state.browser) {
      await this.state.browser.close();
    }
  }
}

module.exports = {
  TelegramClient,
};
