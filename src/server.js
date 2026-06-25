import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildTabbitRequest } from './shared/tabbit-request.js';
import { createOpenAIError, createOpenAIStreamChunk, finalizeOpenAIResponse } from './shared/openai-stream.js';

const DEFAULT_PORT = 8787;
const PAGE_STALE_MS = 5_000;
const TASK_TIMEOUT_MS = 60_000;
const TABBIT_MODELS_URL = 'https://web.tabbit.ai/proxy/v1/model_config/models?a=0&scene=chat';
const MODELS_CACHE_TTL_MS = 5 * 60_000;

export function createBridgeServer({ port = DEFAULT_PORT, taskTimeoutMs = TASK_TIMEOUT_MS } = {}) {
  let sessionState = null;
  let lastPagePingAt = 0;
  let modelsCache = null;
  const pendingTasks = [];
  const activeTasks = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest({
        req,
        res,
        pendingTasks,
        activeTasks,
        taskTimeoutMs,
        getSession: () => sessionState,
        setSession: (state) => { sessionState = state; },
        getLastPagePingAt: () => lastPagePingAt,
        setLastPagePingAt: (value) => { lastPagePingAt = value; },
        getModelsCache: () => modelsCache,
        setModelsCache: (value) => { modelsCache = value; },
      });
    } catch (error) {
      writeJson(res, 500, createOpenAIError(error.message, 'server_error'));
    }
  });

  return {
    start() {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    stop() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    address() {
      return server.address();
    },
  };
}

async function routeRequest({
  req,
  res,
  pendingTasks,
  activeTasks,
  taskTimeoutMs,
  getSession,
  setSession,
  getLastPagePingAt,
  setLastPagePingAt,
  getModelsCache,
  setModelsCache,
}) {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') {
    writeNoContent(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      queued: pendingTasks.length,
      active: activeTasks.size,
      tabbitPageActive: isPageActive(getLastPagePingAt()),
      lastPagePingAt: getLastPagePingAt() || null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__sync/tabbit') {
    const body = await readJson(req);
    setSession(body);
    writeNoContent(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__tabbit/ping') {
    setLastPagePingAt(Date.now());
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__tabbit/tasks/next') {
    setLastPagePingAt(Date.now());
    const task = pendingTasks.shift();
    if (!task) {
      writeNoContent(res);
      return;
    }
    writeJson(res, 200, task.publicTask);
    return;
  }

  const taskMatch = url.pathname.match(/^\/__tabbit\/tasks\/([^/]+)\/(chunk|complete|error)$/);
  if (req.method === 'POST' && taskMatch) {
    setLastPagePingAt(Date.now());
    await handleBrowserTaskUpdate({ req, res, activeTasks, taskId: taskMatch[1], action: taskMatch[2] });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    await handleModels({
      res,
      session: getSession(),
      pendingTasks,
      activeTasks,
      taskTimeoutMs,
      tabbitPageActive: isPageActive(getLastPagePingAt()),
      getModelsCache,
      setModelsCache,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleChatCompletion({
      req,
      res,
      pendingTasks,
      activeTasks,
      session: getSession(),
      taskTimeoutMs,
      tabbitPageActive: isPageActive(getLastPagePingAt()),
    });
    return;
  }

  writeJson(res, 404, createOpenAIError('Not found.'));
}

async function handleModels({ res, session, pendingTasks, activeTasks, taskTimeoutMs, tabbitPageActive, getModelsCache, setModelsCache }) {
  if (!session) {
    writeJson(res, 400, createOpenAIError('Open a Tabbit page before listing models.'));
    return;
  }

  if (!tabbitPageActive) {
    writeJson(res, 400, createOpenAIError('Tabbit extension page worker is not active. Open https://web.tabbit.ai/newtab and reload the extension.'));
    return;
  }

  const cached = getModelsCache();
  if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
    writeJson(res, 200, cached.payload);
    return;
  }

  const taskId = randomUUID();
  const task = {
    id: taskId,
    model: null,
    stream: false,
    text: '',
    thinking: '',
    finishReason: null,
    res: null,
    completed: false,
    publicTask: {
      id: taskId,
      model: null,
      stream: false,
      url: TABBIT_MODELS_URL,
      body: null,
      mode: 'fetch',
    },
  };

  task.timeout = setTimeout(() => {
    completeTaskWithError(activeTasks, task, 'Timed out waiting for Tabbit model list. Check whether the extension is loaded and the Tabbit page is open.');
  }, taskTimeoutMs);

  activeTasks.set(taskId, task);
  pendingTasks.push(task);

  const result = await waitForTask(task);
  cleanupTask(activeTasks, task);

  if (result.error) {
    writeJson(res, 502, createOpenAIError(result.error, 'tabbit_error'));
    return;
  }

  let data;
  try {
    data = JSON.parse(result.text);
  } catch {
    writeJson(res, 502, createOpenAIError('Tabbit model list response was not valid JSON.', 'tabbit_error'));
    return;
  }

  const models = extractModelIds(data);
  if (models.length === 0) {
    const preview = safePreview(data);
    writeJson(res, 502, createOpenAIError(`Tabbit model list response did not contain any models. Preview: ${preview}`, 'tabbit_error'));
    return;
  }

  const payload = {
    object: 'list',
    data: models.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'tabbit',
    })),
  };

  setModelsCache({ fetchedAt: Date.now(), payload });
  writeJson(res, 200, payload);
}

function extractModelIds(data) {
  const ids = [];
  const seen = new Set();
  const idFields = ['id', 'model_id', 'model', 'name', 'key', 'model_name', 'display_name'];

  function pickId(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      for (const field of idFields) {
        const value = item[field];
        if (value !== undefined && value !== null && String(value) !== '') {
          return String(value);
        }
      }
    }
    return null;
  }

  function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        const id = pickId(item);
        if (id !== null) {
          if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }
        if (item && typeof item === 'object') walk(item);
      }
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') walk(value);
      }
    }
  }

  walk(data);
  return ids;
}

function safePreview(data) {
  try {
    const text = JSON.stringify(data);
    return text.length > 400 ? `${text.slice(0, 400)}...` : text;
  } catch {
    return String(data);
  }
}

async function handleChatCompletion({ req, res, pendingTasks, activeTasks, session, taskTimeoutMs, tabbitPageActive }) {
  const body = await readJson(req);

  if (!session) {
    writeJson(res, 400, createOpenAIError('Open a Tabbit page before calling chat completions.'));
    return;
  }

  if (!tabbitPageActive) {
    writeJson(res, 400, createOpenAIError('Tabbit extension page worker is not active. Open https://web.tabbit.ai/newtab and reload the extension.'));
    return;
  }

  const tabbitRequest = buildTabbitRequest(body, session);
  delete tabbitRequest.body.chat_session_id;
  const taskId = randomUUID();
  const task = {
    id: taskId,
    model: body.model,
    stream: Boolean(body.stream),
    text: '',
    thinking: '',
    finishReason: null,
    res: body.stream ? res : null,
    completed: false,
    publicTask: {
      id: taskId,
      model: body.model,
      stream: Boolean(body.stream),
      url: tabbitRequest.url,
      body: tabbitRequest.body,
      mode: 'intercept',
    },
  };

  task.timeout = setTimeout(() => {
    completeTaskWithError(activeTasks, task, 'Timed out waiting for Tabbit page response. Check whether the extension is loaded and the Tabbit page is open.');
  }, taskTimeoutMs);

  activeTasks.set(taskId, task);
  pendingTasks.push(task);

  if (task.stream) {
    res.writeHead(200, corsHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    }));
    req.on('close', () => cleanupTask(activeTasks, task));
    return;
  }

  const result = await waitForTask(task);
  cleanupTask(activeTasks, task);

  if (result.error) {
    writeJson(res, 502, createOpenAIError(result.error, 'tabbit_error'));
    return;
  }

  writeJson(res, 200, finalizeOpenAIResponse({
    model: body.model,
    text: result.text,
    thinking: result.thinking,
    finishReason: task.finishReason,
  }));
}

async function handleBrowserTaskUpdate({ req, res, activeTasks, taskId, action }) {
  const task = activeTasks.get(taskId);
  const body = await readJson(req);

  if (!task) {
    writeJson(res, 404, createOpenAIError('Task not found.'));
    return;
  }

  if (action === 'chunk') {
    const content = body.content ?? '';
    const thinking = body.thinking ?? '';
    const finishReason = body.finish_reason ?? null;

    if (content) task.text += content;
    if (thinking) task.thinking += thinking;
    if (finishReason) task.finishReason = finishReason;

    if (task.stream && (content || thinking)) {
      task.res.write(`data: ${JSON.stringify(createOpenAIStreamChunk({
        model: task.model,
        content: content || undefined,
        thinking: thinking || undefined,
      }))}\n\n`);
    }
    writeNoContent(res);
    return;
  }

  if (action === 'complete') {
    const text = body.text ?? task.text;
    const thinking = body.thinking ?? task.thinking;
    task.completed = true;
    clearTimeout(task.timeout);
    if (task.stream) {
      const finalReason = task.finishReason ?? 'stop';
      if (finalReason) {
        task.res.write(`data: ${JSON.stringify(createOpenAIStreamChunk({
          model: task.model,
          finishReason: finalReason,
        }))}\n\n`);
      }
      task.res.write('data: [DONE]\n\n');
      task.res.end();
      cleanupTask(activeTasks, task);
    } else {
      task.resolve({ text, thinking });
    }
    writeNoContent(res);
    return;
  }

  if (action === 'error') {
    completeTaskWithError(activeTasks, task, body.message ?? 'Tabbit page request failed.');
    writeNoContent(res);
  }
}

function completeTaskWithError(activeTasks, task, message) {
  if (task.completed) return;
  task.completed = true;
  clearTimeout(task.timeout);

  if (task.stream) {
    task.res.write(`data: ${JSON.stringify({ error: { message, type: 'tabbit_error' } })}\n\n`);
    task.res.write('data: [DONE]\n\n');
    task.res.end();
    cleanupTask(activeTasks, task);
  } else {
    task.resolve({ error: message });
  }
}

function cleanupTask(activeTasks, task) {
  clearTimeout(task.timeout);
  activeTasks.delete(task.id);
}

function waitForTask(task) {
  return new Promise((resolve) => {
    task.resolve = resolve;
  });
}

function isPageActive(lastPagePingAt) {
  return Date.now() - lastPagePingAt < PAGE_STALE_MS;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function corsHeaders(headers = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept',
    ...headers,
  };
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, corsHeaders({ 'content-type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

function writeNoContent(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createBridgeServer({ port });
  await server.start();
  console.log(`Tabbit OpenAI bridge listening on http://127.0.0.1:${port}`);
}
