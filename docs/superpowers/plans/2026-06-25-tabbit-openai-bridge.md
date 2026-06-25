# Tabbit OpenAI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chrome extension plus localhost bridge that exposes OpenAI-compatible `POST /v1/chat/completions` on top of an authenticated Tabbit browser session.

**Architecture:** Keep the shared protocol logic in small ESM modules under `src/shared/`. The Node bridge owns HTTP, session storage, and Tabbit forwarding; the Chrome MV3 extension only syncs the active Tabbit session and cookies into the bridge. This keeps the local API stable for external clients while making the browser-side code as thin as possible.

**Tech Stack:** Plain JavaScript ES modules, Node.js built-in `http` and `node:test`, Chrome Extension Manifest V3, `esbuild` for packaging the extension bundle.

---

### Task 1: Bootstrap the project and session parsing

**Files:**
- Create: `package.json`
- Create: `src/shared/session.js`
- Create: `tests/session.test.js`
- Create: `README.md`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTabbitSessionId, normalizeCookieHeader } from '../src/shared/session.js';

test('parses the session id from a Tabbit session URL', () => {
  assert.equal(
    parseTabbitSessionId('https://web.tabbit.ai/session/ab12cf7a-544d-4a35-aacb-41d00ab1fee3'),
    'ab12cf7a-544d-4a35-aacb-41d00ab1fee3',
  );
});

test('normalizes cookies into a single header string', () => {
  assert.equal(
    normalizeCookieHeader([
      { name: 'NEXT_LOCALE', value: 'zh' },
      { name: 'token', value: 'abc' },
    ]),
    'NEXT_LOCALE=zh; token=abc',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session.test.js`
Expected: fail because `src/shared/session.js` does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

```js
export function parseTabbitSessionId(url) {
  const { pathname } = new URL(url);
  const match = pathname.match(/^\/session\/([^/]+)/);
  return match ? match[1] : null;
}

export function normalizeCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/session.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json src/shared/session.js tests/session.test.js README.md
git commit -m "feat: bootstrap tabbit session helpers"
```

### Task 2: Build the Tabbit request adapter

**Files:**
- Create: `src/shared/tabbit-request.js`
- Create: `tests/tabbit-request.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTabbitRequest } from '../src/shared/tabbit-request.js';

test('maps OpenAI chat completions into the Tabbit request shape', () => {
  const request = buildTabbitRequest(
    {
      model: 'GLM-5.2',
      stream: true,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hello' },
      ],
    },
    {
      chatSessionId: 'ab12cf7a-544d-4a35-aacb-41d00ab1fee3',
      cookieHeader: 'token=abc',
      referer: 'https://web.tabbit.ai/session/ab12cf7a-544d-4a35-aacb-41d00ab1fee3',
    },
  );

  assert.equal(request.url, 'https://web.tabbit.ai/api/v1/chat/completion');
  assert.equal(request.headers.cookie, 'token=abc');
  assert.equal(request.headers.referer, 'https://web.tabbit.ai/session/ab12cf7a-544d-4a35-aacb-41d00ab1fee3');
  assert.equal(request.body.chat_session_id, 'ab12cf7a-544d-4a35-aacb-41d00ab1fee3');
  assert.equal(request.body.selected_model, 'GLM-5.2');
  assert.equal(request.body.content, 'hello');
  assert.equal(request.body.agent_mode, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tabbit-request.test.js`
Expected: fail because `buildTabbitRequest` is missing.

- [ ] **Step 3: Write the minimal implementation**

```js
import { randomUUID } from 'node:crypto';

export function buildTabbitRequest(openAiBody, session) {
  const lastUserMessage = [...openAiBody.messages].reverse().find((message) => message.role === 'user');
  return {
    url: 'https://web.tabbit.ai/api/v1/chat/completion',
    headers: {
      cookie: session.cookieHeader,
      origin: 'https://web.tabbit.ai',
      referer: session.referer,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: {
      chat_session_id: session.chatSessionId,
      message_id: randomUUID(),
      content: lastUserMessage?.content ?? '',
      selected_model: openAiBody.model,
      parallel_group_id: null,
      task_name: 'chat',
      agent_mode: false,
      metadatas: { html_content: `<p>${escapeHtml(lastUserMessage?.content ?? '')}</p>` },
      references: [],
      entity: { key: 'd41d8cd98f00b204e9800998ecf8427e', extras: { type: 'tab', url: '' } },
    },
  };
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/tabbit-request.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/tabbit-request.js tests/tabbit-request.test.js
git commit -m "feat: map openai requests to tabbit"
```

### Task 3: Implement stream rewriting and OpenAI responses

**Files:**
- Create: `src/shared/openai-stream.js`
- Create: `tests/openai-stream.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabbitChunkToOpenAIDelta, finalizeOpenAIResponse } from '../src/shared/openai-stream.js';

test('maps a Tabbit chunk into an OpenAI delta', () => {
  const delta = tabbitChunkToOpenAIDelta('{"content":"hello"}');
  assert.equal(delta, 'hello');
});

test('builds a final OpenAI response body', () => {
  const response = finalizeOpenAIResponse({
    model: 'GLM-5.2',
    text: 'hello world',
  });

  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.content, 'hello world');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/openai-stream.test.js`
Expected: fail because the adapter does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

```js
export function tabbitChunkToOpenAIDelta(rawLine) {
  const payload = JSON.parse(rawLine);
  return payload.content ?? payload.delta ?? '';
}

export function finalizeOpenAIResponse({ model, text }) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: text },
      },
    ],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/openai-stream.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/openai-stream.js tests/openai-stream.test.js
git commit -m "feat: rewrite tabbit stream output"
```

### Task 4: Build the localhost bridge server

**Files:**
- Create: `src/server.js`
- Create: `tests/server.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.js';

test('exposes sync and chat endpoints', async () => {
  const server = createBridgeServer({
    port: 0,
    transport: async () => new Response('hello world'),
  });
  await server.start();
  const { port } = server.address();

  const syncResponse = await fetch(`http://127.0.0.1:${port}/__sync/tabbit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatSessionId: 'abc', cookieHeader: 'token=1' }),
  });

  assert.equal(syncResponse.status, 204);

  const chatResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'GLM-5.2',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  const chatBody = await chatResponse.json();
  assert.equal(chatBody.choices[0].message.content, 'hello world');

  await server.stop();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: fail because `createBridgeServer` is missing.

- [ ] **Step 3: Write the minimal implementation**

```js
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { buildTabbitRequest } from './shared/tabbit-request.js';
import { finalizeOpenAIResponse } from './shared/openai-stream.js';

export function createBridgeServer({ port, transport = fetch }) {
  let sessionState = null;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/__sync/tabbit') {
      const body = await readJson(req);
      sessionState = body;
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      if (!sessionState) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No Tabbit session has been synced yet.' } }));
        return;
      }
      const tabbitRequest = buildTabbitRequest(body, sessionState);
      const tabbitResponse = await forwardToTabbit(tabbitRequest, transport);

      if (body.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        await pipeTabbitStreamToOpenAI(tabbitResponse, res, body.model);
        return;
      }

      const tabbitResponseText = await tabbitResponse.text();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(finalizeOpenAIResponse({ model: body.model, text: tabbitResponseText })));
      return;
    }

    res.writeHead(404).end();
  });

  return {
    start() { return new Promise((resolve) => server.listen(port, resolve)); },
    stop() { return new Promise((resolve) => server.close(resolve)); },
    address() { return server.address(); },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function forwardToTabbit(tabbitRequest) {
  return transport(tabbitRequest.url, {
    method: 'POST',
    headers: tabbitRequest.headers,
    body: JSON.stringify(tabbitRequest.body),
  });
}

async function pipeTabbitStreamToOpenAI(tabbitResponse, res, model) {
  const reader = tabbitResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) {
        const delta = line.slice(5).trim();
        if (delta && delta !== '[DONE]') {
          const content = delta.startsWith('{') ? JSON.parse(delta).content ?? '' : delta;
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`);
        }
      }
      if (line === 'data: [DONE]') {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      index = buffer.indexOf('\n');
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js tests/server.test.js
git commit -m "feat: add localhost bridge server"
```

### Task 5: Add the Chrome MV3 session sync extension

**Files:**
- Create: `src/extension/manifest.json`
- Create: `src/extension/background.js`
- Create: `tests/extension-sync.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTabbitSessionState } from '../src/extension/background.js';

test('extracts the session id from a Tabbit tab URL', () => {
  const state = extractTabbitSessionState({
    url: 'https://web.tabbit.ai/session/ab12cf7a-544d-4a35-aacb-41d00ab1fee3',
    cookies: [{ name: 'token', value: 'abc' }],
  });

  assert.equal(state.chatSessionId, 'ab12cf7a-544d-4a35-aacb-41d00ab1fee3');
  assert.equal(state.cookieHeader, 'token=abc');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/extension-sync.test.js`
Expected: fail because `extractTabbitSessionState` is missing.

- [ ] **Step 3: Write the minimal implementation**

```js
import { parseTabbitSessionId, normalizeCookieHeader } from '../shared/session.js';

export function extractTabbitSessionState({ url, cookies }) {
  return {
    chatSessionId: parseTabbitSessionId(url),
    cookieHeader: normalizeCookieHeader(cookies),
    referer: url,
  };
}
```

```json
{
  "manifest_version": 3,
  "name": "Tabbit OpenAI Bridge",
  "version": "0.1.0",
  "permissions": ["cookies", "tabs", "storage"],
  "host_permissions": ["https://web.tabbit.ai/*", "http://127.0.0.1/*"],
  "background": { "service_worker": "background.js", "type": "module" }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/extension-sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extension/manifest.json src/extension/background.js tests/extension-sync.test.js
git commit -m "feat: sync tabbit session from chrome"
```

### Task 6: Package and smoke test the full flow

**Files:**
- Create: `scripts/build.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write the failing smoke check**

```bash
node src/server.js
curl.exe -L http://127.0.0.1:8787/v1/chat/completions
```

Expected: the server should start and reject requests cleanly until a session has been synced.

- [ ] **Step 2: Add the packaging script**

```json
{
  "scripts": {
    "test": "node --test",
    "start:bridge": "node src/server.js",
    "build": "node scripts/build.mjs"
  }
}
```

```js
import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/extension', { recursive: true });
await build({
  entryPoints: ['src/extension/background.js'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/extension/background.js',
});
await copyFile('src/extension/manifest.json', 'dist/extension/manifest.json');
```

- [ ] **Step 3: Run the smoke check**

Run:
`npm test`
`npm run build`

Expected: all tests pass and both `dist/extension/background.js` and `dist/extension/manifest.json` exist.

- [ ] **Step 4: Commit**

```bash
git add scripts/build.mjs README.md package.json
git commit -m "feat: package and document the bridge"
```
