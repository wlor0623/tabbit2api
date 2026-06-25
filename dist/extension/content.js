(() => {
  // src/extension/content.js
  var BRIDGE_ORIGIN = "http://127.0.0.1:8787";
  var TASK_POLL_INTERVAL_MS = 500;
  var PING_INTERVAL_MS = 1e3;
  var EDITOR_SELECTOR = 'div[data-blur-action="editor-focus"]';
  var SEND_BUTTON_SELECTOR = "#ChatSendButton";
  var PAGE_HOOK_SOURCE = "tabbit-openai-bridge-page-hook";
  var COMPLETION_TIMEOUT_MS = 12e4;
  if (!globalThis.__tabbitOpenAIBridgeLoaded) {
    globalThis.__tabbitOpenAIBridgeLoaded = true;
    startBridgeContentScript();
  }
  function startBridgeContentScript() {
    console.log("[TabbitBridge:content] content.js loaded at document_start, injecting page-hook...");
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page-hook.js");
      script.async = false;
      script.onload = () => console.log("[TabbitBridge:content] page-hook.js script tag loaded");
      script.onerror = (e) => console.error("[TabbitBridge:content] page-hook.js script tag failed:", e);
      (document.head || document.documentElement).appendChild(script);
    } catch (error) {
      console.error("[TabbitBridge:content] failed to inject page-hook.js:", error);
    }
    let isRunning = false;
    let bridgeOnline = false;
    let currentStatus = "connecting";
    let statusText = "\u6B63\u5728\u8FDE\u63A5\u672C\u5730 bridge";
    let activeTaskCount = 0;
    let activeTask = null;
    let pageHookReady = false;
    let updateQueue = Promise.resolve();
    function serializedPostTaskUpdate(taskId, action, body) {
      const run = () => postTaskUpdate(taskId, action, body);
      updateQueue = updateQueue.then(run, run);
      return updateQueue;
    }
    const badge = createStatusBadge();
    const panel = createTestPanel();
    updateBadge();
    async function pingBridge() {
      try {
        const response = await fetch(`${BRIDGE_ORIGIN}/__tabbit/ping`, { method: "POST" });
        bridgeOnline = response.ok;
        if (bridgeOnline && currentStatus === "connecting") {
          setStatus("ready", "\u63D2\u4EF6\u5DF2\u52A0\u8F7D\uFF0Cbridge \u5DF2\u8FDE\u63A5");
        }
      } catch {
        bridgeOnline = false;
        setStatus("offline", "\u672C\u5730 bridge \u672A\u8FDE\u63A5\uFF0C\u8BF7\u542F\u52A8 npm run start:bridge");
      }
      updateBadge();
    }
    async function pollTasks() {
      if (isRunning || !bridgeOnline) return;
      isRunning = true;
      try {
        while (true) {
          const response = await fetch(`${BRIDGE_ORIGIN}/__tabbit/tasks/next`);
          if (response.status === 204) break;
          if (!response.ok) throw new Error(`Task polling failed: ${response.status}`);
          const task = await response.json();
          activeTaskCount += 1;
          setStatus("working", "\u6B63\u5728\u5411 Tabbit \u9875\u9762\u8F93\u5165\u5E76\u53D1\u9001");
          try {
            await executeTask(task);
          } finally {
            activeTaskCount = Math.max(0, activeTaskCount - 1);
            if (activeTaskCount === 0 && currentStatus !== "error") {
              setStatus("ready", "\u63D2\u4EF6\u5DF2\u52A0\u8F7D\uFF0C\u7B49\u5F85\u8BF7\u6C42");
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Tabbit OpenAI Bridge pollTasks failed:", error);
        setStatus("error", message);
      } finally {
        isRunning = false;
      }
    }
    async function executeTask(task) {
      console.log("[TabbitBridge:content] executeTask start, task.id=", task.id, "mode=", task.mode);
      if (task.mode === "fetch") {
        await executeFetchTask(task);
        return;
      }
      console.log("[TabbitBridge:content] content=", (task.body?.content ?? "").slice(0, 50));
      console.log("[TabbitBridge:content] pageHookReady=", pageHookReady);
      if (!pageHookReady) {
        console.warn("[TabbitBridge:content] page-hook ready message not received (content.js loads after page-hook). If interception fails, check page console for [TabbitBridge:page-hook] logs.");
      }
      activeTask = task;
      let resolveCompletion;
      let rejectCompletion;
      const completionPromise = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const completionHandlers = { resolve: resolveCompletion, reject: rejectCompletion };
      activeTask.completionHandlers = completionHandlers;
      const timeout = setTimeout(() => {
        completionHandlers.reject(new Error("\u7B49\u5F85 Tabbit \u63A5\u53E3\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u786E\u8BA4\u9875\u9762\u5DF2\u767B\u5F55\u4E14\u53D1\u9001\u6210\u529F\u3002"));
      }, COMPLETION_TIMEOUT_MS);
      try {
        const content = task.body?.content ?? "";
        await sendTextToTabbitPage(content);
        console.log("[TabbitBridge:content] sent text to page, waiting for intercepted response...");
        const result = await completionPromise;
        console.log("[TabbitBridge:content] got intercepted response, text.length=", result.text.length);
        clearTimeout(timeout);
        await serializedPostTaskUpdate(task.id, "complete", {
          text: result.text,
          thinking: result.thinking
        });
      } catch (error) {
        clearTimeout(timeout);
        const message = error instanceof Error ? error.message : String(error);
        console.error("[TabbitBridge:content] executeTask failed:", message);
        setStatus("error", message);
        await postTaskUpdate(task.id, "error", { message });
        throw error;
      } finally {
        if (activeTask === task) activeTask = null;
      }
    }
    async function executeFetchTask(task) {
      activeTask = task;
      try {
        console.log("[TabbitBridge:content] fetch task ->", task.url);
        const response = await fetch(task.url, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`Tabbit fetch failed: ${response.status}`);
        }
        const data = await response.json();
        await serializedPostTaskUpdate(task.id, "complete", {
          text: JSON.stringify(data)
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[TabbitBridge:content] fetch task failed:", message);
        setStatus("error", message);
        await postTaskUpdate(task.id, "error", { message });
        throw error;
      } finally {
        if (activeTask === task) activeTask = null;
      }
    }
    function handlePageHookMessage(event) {
      const data = event.data;
      if (!data || data.source !== PAGE_HOOK_SOURCE) return;
      if (data.type === "tabbit-completion-hook-ready") {
        console.log("[TabbitBridge:content] page-hook is ready (fetch + XHR hooked)");
        pageHookReady = true;
        return;
      }
      if (!activeTask || !activeTask.completionHandlers) {
        if (data.type === "tabbit-completion-chunk" || data.type === "tabbit-completion-done" || data.type === "tabbit-completion-error") {
          console.warn("[TabbitBridge:content] received page-hook message but no active task:", data.type);
        }
        return;
      }
      if (data.type === "tabbit-completion-chunk") {
        const chunk = data.chunk ?? {};
        const body = {};
        if (chunk.content) body.content = chunk.content;
        if (chunk.thinking) body.thinking = chunk.thinking;
        if (chunk.finish_reason) body.finish_reason = chunk.finish_reason;
        if (Object.keys(body).length > 0) {
          serializedPostTaskUpdate(activeTask.id, "chunk", body).catch(() => {
          });
        }
        return;
      }
      if (data.type === "tabbit-completion-done") {
        activeTask.completionHandlers.resolve({
          text: data.text ?? "",
          thinking: data.thinking ?? ""
        });
        return;
      }
      if (data.type === "tabbit-completion-error") {
        activeTask.completionHandlers.reject(new Error(data.message ?? "Tabbit \u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF\u3002"));
      }
    }
    window.addEventListener("message", handlePageHookMessage);
    console.log("[TabbitBridge:content] message listener registered for page-hook");
    async function sendTextToTabbitPage(text) {
      const editor = await waitForElement(EDITOR_SELECTOR, 1e4);
      await focusAndSetEditorText(editor, text);
      const sendButton = await waitForClickableSendButton(5e3);
      sendButton.click();
    }
    async function focusAndSetEditorText(editor, text) {
      editor.scrollIntoView({ block: "center", inline: "nearest" });
      editor.click();
      editor.focus();
      await delay(50);
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) {
        await writeTextWithClipboard(editor, text);
      }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: text.at(-1) || "" }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    }
    async function writeTextWithClipboard(editor, text) {
      await navigator.clipboard.writeText(text);
      editor.focus();
      document.execCommand("paste", false, null);
    }
    async function waitForClickableSendButton(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const button = document.querySelector(SEND_BUTTON_SELECTOR);
        if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
          return button;
        }
        await delay(100);
      }
      throw new Error("Tabbit \u53D1\u9001\u6309\u94AE\u4E0D\u53EF\u7528\uFF0C\u8BF7\u786E\u8BA4\u8F93\u5165\u6846\u5DF2\u6210\u529F\u8F93\u5165\u4E14\u9875\u9762\u5DF2\u767B\u5F55\u3002");
    }
    function waitForElement(selector, timeoutMs) {
      const existing = document.querySelector(selector);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`\u627E\u4E0D\u5230\u9875\u9762\u5143\u7D20\uFF1A${selector}`));
        }, timeoutMs);
        const observer = new MutationObserver(() => {
          const element = document.querySelector(selector);
          if (!element) return;
          clearTimeout(timeout);
          observer.disconnect();
          resolve(element);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    }
    async function postTaskUpdate(taskId, action, body) {
      await fetch(`${BRIDGE_ORIGIN}/__tabbit/tasks/${taskId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    }
    function createStatusBadge() {
      const container = document.createElement("div");
      container.id = "tabbit-openai-bridge-status";
      container.style.cssText = [
        "position:fixed",
        "right:16px",
        "top:40%",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "gap:8px",
        "padding:8px 10px",
        "border-radius:999px",
        'font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        "color:#fff",
        "box-shadow:0 8px 24px rgba(0,0,0,.18)",
        "cursor:pointer",
        "user-select:none"
      ].join(";");
      const dot = document.createElement("span");
      dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block;opacity:.95";
      const label = document.createElement("span");
      container.addEventListener("click", () => {
        panel.container.hidden = !panel.container.hidden;
      });
      container.append(dot, label);
      document.documentElement.append(container);
      return { container, label };
    }
    function createTestPanel() {
      const container = document.createElement("div");
      container.id = "tabbit-openai-bridge-panel";
      container.hidden = true;
      container.style.cssText = [
        "position:fixed",
        "right:16px",
        "top:calc(40% + 48px)",
        "z-index:2147483647",
        "width:300px",
        "padding:12px",
        "border-radius:12px",
        "background:#fff",
        "color:#0f172a",
        "box-shadow:0 12px 32px rgba(15,23,42,.24)",
        'font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        "border:1px solid rgba(15,23,42,.12)"
      ].join(";");
      const title = document.createElement("div");
      title.textContent = "Tabbit Bridge \u6D4B\u8BD5";
      title.style.cssText = "font-weight:700;margin-bottom:8px";
      const textarea = document.createElement("textarea");
      textarea.value = "\u8FD9\u662F\u4E00\u6761 Tabbit Bridge \u6D4B\u8BD5\u6D88\u606F";
      textarea.style.cssText = [
        "box-sizing:border-box",
        "width:100%",
        "height:76px",
        "resize:vertical",
        "padding:8px",
        "border-radius:8px",
        "border:1px solid #cbd5e1",
        "outline:none",
        "font:13px/1.4 inherit",
        "color:#0f172a",
        "background:#fff"
      ].join(";");
      const button = document.createElement("button");
      button.textContent = "\u53D1\u9001\u6D4B\u8BD5\u6D88\u606F";
      button.style.cssText = [
        "margin-top:8px",
        "width:100%",
        "height:34px",
        "border:0",
        "border-radius:8px",
        "background:#2563eb",
        "color:#fff",
        "font-weight:600",
        "cursor:pointer"
      ].join(";");
      const message = document.createElement("div");
      message.style.cssText = "margin-top:8px;color:#475569;white-space:pre-wrap;word-break:break-word";
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "\u53D1\u9001\u4E2D...";
        message.textContent = "";
        try {
          await sendTextToTabbitPage(textarea.value.trim() || "\u8FD9\u662F\u4E00\u6761 Tabbit Bridge \u6D4B\u8BD5\u6D88\u606F");
          message.textContent = "\u5DF2\u70B9\u51FB\u53D1\u9001\uFF0C\u8BF7\u5728 Tabbit \u9875\u9762\u67E5\u770B\u3002";
          setStatus("ready", "\u6D4B\u8BD5\u6D88\u606F\u5DF2\u63D0\u4EA4\u5230 Tabbit \u9875\u9762");
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          message.textContent = errorMessage;
          setStatus("error", errorMessage);
        } finally {
          button.disabled = false;
          button.textContent = "\u53D1\u9001\u6D4B\u8BD5\u6D88\u606F";
        }
      });
      container.append(title, textarea, button, message);
      document.documentElement.append(container);
      return { container, textarea, button, message };
    }
    function setStatus(status, text) {
      currentStatus = status;
      statusText = text;
      updateBadge();
    }
    function updateBadge() {
      const config = {
        connecting: { background: "#64748b", label: "Bridge \u8FDE\u63A5\u4E2D" },
        ready: { background: "#16a34a", label: "Bridge \u5DF2\u5C31\u7EEA" },
        working: { background: "#2563eb", label: "Bridge \u8F93\u5165\u4E2D" },
        offline: { background: "#dc2626", label: "Bridge \u672A\u8FDE\u63A5" },
        error: { background: "#ea580c", label: "Bridge \u5F02\u5E38" }
      }[currentStatus];
      badge.container.style.background = config.background;
      badge.container.title = statusText;
      badge.label.textContent = config.label;
    }
    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    setInterval(pingBridge, PING_INTERVAL_MS);
    setInterval(pollTasks, TASK_POLL_INTERVAL_MS);
    pingBridge();
    pollTasks();
  }
})();
