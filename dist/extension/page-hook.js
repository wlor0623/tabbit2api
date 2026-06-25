(() => {
  // src/extension/page-hook.js
  var TABBIT_COMPLETION_PATH = "/api/v1/chat/completion";
  var MESSAGE_SOURCE = "tabbit-openai-bridge-page-hook";
  var TAG = "[TabbitBridge:page-hook]";
  if (!globalThis.__tabbitOpenAIBridgePageHookLoaded) {
    globalThis.__tabbitOpenAIBridgePageHookLoaded = true;
    console.log(TAG, "installing hooks at", location.href);
    installTabbitCompletionHook();
    postMessage({ type: "tabbit-completion-hook-ready" });
  }
  var currentlyIntercepting = false;
  function installTabbitCompletionHook() {
    hookFetch();
    hookXHR();
  }
  function hookFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      console.warn(TAG, "window.fetch is not a function, skipping fetch hook");
      return;
    }
    window.fetch = async function fetchHook(input, init) {
      const url = getRequestUrl(input);
      const response = await originalFetch.call(this, input, init);
      if (!url.includes(TABBIT_COMPLETION_PATH)) {
        return response;
      }
      if (currentlyIntercepting) {
        console.log(TAG, "[fetch] already intercepting another request, skipping");
        return response;
      }
      currentlyIntercepting = true;
      console.log(TAG, "[fetch] intercepted ->", url, "status:", response.status, "ct:", response.headers.get("content-type"));
      if (!response.body) {
        console.warn(TAG, "[fetch] response has no body");
        currentlyIntercepting = false;
        return response;
      }
      let cloned;
      try {
        cloned = response.clone();
      } catch (error) {
        console.warn(TAG, "[fetch] clone failed:", error);
        currentlyIntercepting = false;
        return response;
      }
      readCompletionStream(cloned, "fetch").catch((error) => {
        console.error(TAG, "[fetch] readCompletionStream failed:", error);
        postMessage({ type: "tabbit-completion-error", message: `[fetch] ${error?.message ?? error}` });
      }).finally(() => {
        currentlyIntercepting = false;
      });
      return response;
    };
    console.log(TAG, "fetch hook installed");
  }
  function hookXHR() {
    const OriginalXHR = window.XMLHttpRequest;
    if (typeof OriginalXHR !== "function") {
      console.warn(TAG, "XMLHttpRequest is not available, skipping XHR hook");
      return;
    }
    function PatchedXHR() {
      const xhr = new OriginalXHR();
      let intercepted = false;
      let accumulator = null;
      const origOpen = xhr.open;
      xhr.open = function(method, url, ...rest) {
        xhr.__tabbitUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      xhr.addEventListener("readystatechange", function() {
        const url = xhr.__tabbitUrl ?? "";
        if (!url.includes(TABBIT_COMPLETION_PATH)) return;
        if (xhr.readyState < 3) return;
        if (!intercepted) {
          if (currentlyIntercepting) {
            console.log(TAG, "[xhr] already intercepting another request, skipping");
            return;
          }
          currentlyIntercepting = true;
          intercepted = true;
          console.log(TAG, "[xhr] intercepted ->", url, "status:", xhr.status, "ct:", xhr.getResponseHeader("content-type"));
          accumulator = { content: "", thinking: "" };
        }
        try {
          const fullText = xhr.responseText ?? "";
          processXhrSse(fullText, accumulator);
        } catch (error) {
          console.warn(TAG, "[xhr] readystatechange parse failed:", error);
        }
      });
      xhr.addEventListener("loadend", function() {
        const url = xhr.__tabbitUrl ?? "";
        if (!url.includes(TABBIT_COMPLETION_PATH)) return;
        if (!intercepted) return;
        try {
          const fullText = xhr.responseText ?? "";
          const finalAcc = processXhrSse(fullText, accumulator, true);
          console.log(TAG, "[xhr] loadend. content length:", finalAcc.content.length);
          postCompletionDone(finalAcc);
        } catch (error) {
          console.error(TAG, "[xhr] loadend failed:", error);
          postMessage({ type: "tabbit-completion-error", message: `[xhr] ${error?.message ?? error}` });
        } finally {
          currentlyIntercepting = false;
        }
      });
      return xhr;
    }
    PatchedXHR.prototype = OriginalXHR.prototype;
    Object.setPrototypeOf(PatchedXHR, OriginalXHR);
    window.XMLHttpRequest = PatchedXHR;
    console.log(TAG, "XMLHttpRequest hook installed");
  }
  var xhrProgress = /* @__PURE__ */ new WeakMap();
  function processXhrSse(fullText, accumulator, isFinal = false) {
    if (!accumulator) {
      accumulator = { content: "", thinking: "" };
    }
    const state = xhrProgress.get(accumulator) ?? { lastSeen: 0, buffer: "" };
    if (fullText.length <= state.lastSeen) return accumulator;
    const newPart = fullText.slice(state.lastSeen);
    state.lastSeen = fullText.length;
    let buffer = state.buffer + newPart;
    const lines = buffer.split(/\r?\n/);
    if (isFinal) {
      state.buffer = "";
    } else {
      state.buffer = lines.pop() ?? "";
    }
    xhrProgress.set(accumulator, state);
    for (const line of lines) {
      const event = parseSseLine(line);
      if (!event) continue;
      if (event.done) {
        postCompletionDone(accumulator);
        return accumulator;
      }
      if (event.error) {
        postMessage({ type: "tabbit-completion-error", message: event.error });
        continue;
      }
      if (event.chunk) {
        accumulateChunk(accumulator, event.chunk);
        postMessage({ type: "tabbit-completion-chunk", chunk: event.chunk });
      }
    }
    if (isFinal && state.buffer) {
      const finalEvent = parseSseLine(state.buffer);
      if (finalEvent?.chunk) {
        accumulateChunk(accumulator, finalEvent.chunk);
        postMessage({ type: "tabbit-completion-chunk", chunk: finalEvent.chunk });
      }
    }
    return accumulator;
  }
  async function readCompletionStream(response, via) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let chunkCount = 0;
    const accumulated = { content: "", thinking: "" };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      totalBytes += text.length;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseSseLine(line);
        if (!event) continue;
        if (event.done) {
          console.log(TAG, `[${via}] done event. chunks:`, chunkCount, "bytes:", totalBytes);
          postCompletionDone(accumulated);
          return;
        }
        if (event.error) {
          console.warn(TAG, `[${via}] error event:`, event.error);
          postMessage({ type: "tabbit-completion-error", message: event.error });
          continue;
        }
        if (event.chunk) {
          chunkCount += 1;
          if (chunkCount <= 3) console.log(TAG, `[${via}] chunk #`, chunkCount, event.chunk);
          accumulateChunk(accumulated, event.chunk);
          postMessage({ type: "tabbit-completion-chunk", chunk: event.chunk });
        }
      }
    }
    console.log(TAG, `[${via}] stream ended. chunks:`, chunkCount, "bytes:", totalBytes, "buffer:", JSON.stringify(buffer.slice(0, 200)));
    const finalEvent = parseSseLine(buffer);
    if (finalEvent?.chunk) {
      accumulateChunk(accumulated, finalEvent.chunk);
      postMessage({ type: "tabbit-completion-chunk", chunk: finalEvent.chunk });
    }
    postCompletionDone(accumulated);
  }
  function parseSseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed === "data: [DONE]" || trimmed === "[DONE]") return { done: true };
    if (trimmed.startsWith("event:")) {
      const eventName = trimmed.slice(6).trim().toLowerCase();
      if (eventName === "error") return { error: "Tabbit returned an SSE error event." };
      if (eventName === "finish" || eventName === "done" || eventName === "end") return { done: true };
      return null;
    }
    let payloadText;
    if (trimmed.startsWith("data:")) {
      payloadText = trimmed.slice(5).trim();
    } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      payloadText = trimmed;
    } else {
      return null;
    }
    if (!payloadText || payloadText === "[DONE]") return { done: true };
    try {
      const payload = JSON.parse(payloadText);
      const chunk = extractChunk(payload);
      if (chunk) return { chunk };
      if (payload.error) return { error: payload.error.message ?? JSON.stringify(payload.error) };
      if (payload.type === "finish" || payload.type === "done" || payload.event === "finish") {
        return { done: true };
      }
      return null;
    } catch {
      if (payloadText.includes('"finish"') || payloadText.includes('"done"')) {
        return { done: true };
      }
      return { chunk: { content: payloadText } };
    }
  }
  function extractChunk(payload) {
    const chunk = {};
    const content = pick(payload, [
      "content",
      "delta",
      "text",
      "message.content",
      "data.content",
      "data.delta",
      "data.text",
      "choices.0.delta.content",
      "choices.0.message.content"
    ]);
    if (content) chunk.content = content;
    const thinking = pick(payload, [
      "thinking",
      "reasoning",
      "reasoning_content",
      "data.thinking",
      "data.reasoning",
      "data.reasoning_content",
      "choices.0.delta.reasoning_content",
      "choices.0.delta.reasoning",
      "choices.0.message.reasoning_content"
    ]);
    if (thinking) chunk.thinking = thinking;
    const finishReason = pick(payload, [
      "finish_reason",
      "choices.0.finish_reason",
      "data.finish_reason"
    ]);
    if (finishReason) chunk.finish_reason = finishReason;
    if (Object.keys(chunk).length === 0) return null;
    return chunk;
  }
  function accumulateChunk(accumulated, chunk) {
    if (chunk.content) accumulated.content += chunk.content;
    if (chunk.thinking) accumulated.thinking += chunk.thinking;
  }
  function postCompletionDone(accumulated) {
    console.log(TAG, "completion done. content length:", accumulated.content.length, "thinking length:", accumulated.thinking.length);
    postMessage({
      type: "tabbit-completion-done",
      text: accumulated.content,
      thinking: accumulated.thinking
    });
  }
  function postMessage(payload) {
    window.postMessage({ source: MESSAGE_SOURCE, ...payload }, "*");
  }
  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input?.url ?? "";
  }
  function pick(obj, paths) {
    for (const path of paths) {
      const value = getPath(obj, path);
      if (value !== void 0 && value !== null && value !== "") return value;
    }
    return void 0;
  }
  function getPath(obj, path) {
    return path.split(".").reduce((acc, key) => {
      if (acc === void 0 || acc === null) return void 0;
      if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)];
      return acc[key];
    }, obj);
  }
})();
