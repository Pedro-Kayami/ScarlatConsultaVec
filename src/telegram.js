const puppeteer = require("puppeteer");

const CHAT_SELECTOR = "a.chatlist-chat";
const CHAT_TITLE_SELECTOR = "div.row-title span.peer-title";
const CHAT_INPUT_CONTAINER_SELECTOR = ".chat-input-container";
const CHAT_INPUT_CONTROL_SELECTOR = ".chat-input-control .chat-input-control-button:not(.hide)";
const INPUT_SELECTOR =
  ".input-message-input[contenteditable='true'][data-peer-id]:not(.input-field-input-fake), " +
  ".input-message-input[contenteditable='true']:not(.input-field-input-fake)";

class TelegramClient {
  constructor(config, debugLog) {
    this.config = config;
    this.debugLog = debugLog;
    this.state = {
      browser: null,
      page: null,
      opening: null,
      queue: Promise.resolve(),
    };
  }

  runExclusive(task) {
    const next = this.state.queue.then(task, task);
    this.state.queue = next.catch(() => {});
    return next;
  }

  async launchBrowser() {
    this.debugLog("launchBrowser start");
    const browser = await puppeteer.launch({
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      userDataDir: this.config.userDataDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

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

  async waitForChatList(page) {
    await page.waitForSelector("ul.chatlist", { timeout: this.config.navTimeoutMs });
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length > 0,
      { timeout: this.config.navTimeoutMs },
      CHAT_SELECTOR
    );
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

  async openChat(page) {
    if (!this.config.chatName) {
      return;
    }

    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const target = normalize(this.config.chatName);

    this.debugLog("openChat start", target);
    await this.waitForChatList(page);
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
    return page.evaluate((selector, value) => {
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

      const candidates = Array.from(document.querySelectorAll(selector));
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
    }, INPUT_SELECTOR, text);
  }

  async tryInsertMessage(page, text) {
    await page
      .waitForSelector(CHAT_INPUT_CONTAINER_SELECTOR, {
        timeout: this.config.navTimeoutMs,
      })
      .catch(() => {});

    return page.evaluate(
      (controlSelector, inputSelector, value) => {
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

        const el = document.querySelector(inputSelector);

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
      INPUT_SELECTOR,
      text
    );
  }

  async clickChatControlIfNeeded(page) {
    const keywords = [
      "start",
      "iniciar",
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
        const bubbles = Array.from(document.querySelectorAll("div.bubble-content"));

        return bubbles.some((bubble) => {
          const reply = bubble.querySelector(".reply-subtitle");
          const replyText = reply ? normalize(reply.textContent || "") : "";
          const message = bubble.querySelector(".translatable-message");
          const messageText = message ? normalize(message.textContent || "") : "";
          if (replyTarget) {
            return replyText.includes(replyTarget) && Boolean(bubble.querySelector("img.media-photo"));
          }
          if (!messageText.includes(target)) {
            return false;
          }
          return Boolean(bubble.querySelector("img.media-photo"));
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
        .querySelectorAll("img.media-photo[data-captcha-target]")
        .forEach((img) => img.removeAttribute("data-captcha-target"));

      const bubbles = Array.from(document.querySelectorAll("div.bubble-content"));
      const candidates = [];
      for (const bubble of bubbles) {
        const reply = bubble.querySelector(".reply-subtitle");
        const replyText = reply ? normalize(reply.textContent || "") : "";
        const message = bubble.querySelector(".translatable-message");
        const messageText = message ? normalize(message.textContent || "") : "";
        if (replyTarget && !replyText.includes(replyTarget)) {
          continue;
        }
        if (!replyTarget && !messageText.includes(target)) {
          continue;
        }

        const img = bubble.querySelector("img.media-photo");
        if (!img) {
          continue;
        }
        const rect = bubble.getBoundingClientRect();
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

    const imageHandle = await page.$("img.media-photo[data-captcha-target='true']");
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
        const bubbles = Array.from(document.querySelectorAll("div.bubble-content"));

        if (replyTarget) {
          return bubbles.some((bubble) => {
            const reply = bubble.querySelector(".reply-subtitle");
            const replyText = reply ? normalize(reply.textContent || "") : "";
            if (!replyText.includes(replyTarget)) {
              return false;
            }
            return Boolean(bubble.querySelector(".reply-markup-button"));
          });
        }

        return document.querySelectorAll(".reply-markup-button").length > 0;
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

      const levenshtein = (a, b) => {
        const m = a.length;
        const n = b.length;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 0; i <= m; i += 1) dp[i][0] = i;
        for (let j = 0; j <= n; j += 1) dp[0][j] = j;
        for (let i = 1; i <= m; i += 1) {
          for (let j = 1; j <= n; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
              dp[i - 1][j] + 1,
              dp[i][j - 1] + 1,
              dp[i - 1][j - 1] + cost
            );
          }
        }
        return dp[m][n];
      };

      const target = normalize(value);
      if (!target) {
        return { clicked: false, reason: "empty-target" };
      }

      const normalizeReply = (input) =>
        String(input || "").replace(/\s+/g, " ").trim().toLowerCase();
      const replyTarget = placaValue ? normalizeReply(`/placa ${placaValue}`) : "";

      const wrappers = Array.from(document.querySelectorAll("div.bubble-content-wrapper"));
      const candidates = [];

      for (const wrapper of wrappers) {
        const bubble = wrapper.querySelector("div.bubble-content");
        if (!bubble) {
          continue;
        }
        const reply = bubble.querySelector(".reply-subtitle");
        const replyText = reply ? normalizeReply(reply.textContent || "") : "";
        if (replyTarget && !replyText.includes(replyTarget)) {
          continue;
        }
        const buttons = wrapper.querySelectorAll(".reply-markup-button");
        if (buttons.length > 0) {
          const rect = bubble.getBoundingClientRect();
          candidates.push({ buttons: Array.from(buttons), bottom: rect.bottom });
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
      } else {
        options = Array.from(document.querySelectorAll(".reply-markup-button"));
      }

      if (options.length === 0) {
        return { clicked: false, reason: "no-options" };
      }

      const mapped = options
        .map((button) => {
          const textEl = button.querySelector(".reply-markup-button-text");
          const label = textEl ? textEl.textContent || "" : button.textContent || "";
          const norm = normalize(label);
          return { button, label, norm };
        })
        .filter((entry) => entry.norm);

      for (const entry of mapped) {
        if (entry.norm === target) {
          entry.button.click();
          return { clicked: true, match: "exact", label: entry.label };
        }
      }

      const targetSuffix = target.slice(-4);
      if (targetSuffix.length === 4) {
        for (const entry of mapped) {
          if (entry.norm.endsWith(targetSuffix)) {
            entry.button.click();
            return { clicked: true, match: "suffix-4", label: entry.label };
          }
        }
      }

      let best = null;
      for (const entry of mapped) {
        const distance = levenshtein(target, entry.norm);
        if (!best || distance < best.distance) {
          best = { entry, distance };
        }
      }

      if (best && best.distance <= 1) {
        best.entry.button.click();
        return { clicked: true, match: "fuzzy", label: best.entry.label, distance: best.distance };
      }

      return {
        clicked: false,
        reason: "no-match",
        target,
        options: mapped.map((entry) => entry.label),
      };
    }, placa || "", text);

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
              entry.button.click();
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

      const buttons = Array.from(matchedWrapper.querySelectorAll(".reply-markup-button"));
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
          entry.button.click();
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
            const buttons = wrapper.querySelectorAll(".reply-markup-button-text");
            for (const button of buttons) {
              if (matchLabel(button.textContent || "")) {
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
          button.click();
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
          const buttons = wrapper.querySelectorAll(".reply-markup-button");
          for (const button of buttons) {
            const labelEl = button.querySelector(".reply-markup-button-text") || button;
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
        button.click();
        return { clicked: true, match: "label" };
      }

      return { clicked: false, reason: "no-match" };
    }, label, placa || "", moduleName || "");

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
          document.querySelectorAll(".popup-container .popup-button, .popup-buttons .popup-button")
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
    await this.ensureChatOpen(page);
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

      const buttons = Array.from(
        document.querySelectorAll(".popup-container .popup-button, .popup-buttons .popup-button")
      );
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const text = normalize(button.textContent || "");
        if (targets.some((label) => text.includes(label))) {
          button.click();
          return { clicked: true, match: text };
        }
      }

      return { clicked: false, reason: "no-popup" };
    }, labels);

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
