import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.js';

test('queues chat tasks for the Tabbit page and returns non-stream result', async () => {
  const server = createBridgeServer({ port: 0 });
  await server.start();
  const { port } = server.address();

  try {
    const syncResponse = await fetch(`http://127.0.0.1:${port}/__sync/tabbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatSessionId: null,
        cookieHeader: 'token=1',
        referer: 'https://web.tabbit.ai/newtab',
      }),
    });
    const pingResponse = await fetch(`http://127.0.0.1:${port}/__tabbit/ping`, { method: 'POST' });

    assert.equal(syncResponse.status, 204);
    assert.equal(pingResponse.status, 200);

    const chatPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'GLM-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const taskResponse = await waitForTask(port);
    const task = await taskResponse.json();

    assert.equal(task.model, 'GLM-5.2');
    assert.equal(task.stream, false);
    assert.equal(task.mode, 'intercept');
    assert.equal(task.url, 'https://web.tabbit.ai/api/v1/chat/completion');
    assert.equal(task.body.content, 'hello');

    await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/${task.id}/chunk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello ' }),
    });
    await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello world' }),
    });

    const chatResponse = await chatPromise;
    const chatBody = await chatResponse.json();
    assert.equal(chatResponse.status, 200);
    assert.equal(chatBody.choices[0].message.content, 'hello world');
  } finally {
    await server.stop();
  }
});

test('returns an OpenAI-style error before Tabbit page sync', async () => {
  const server = createBridgeServer({ port: 0 });
  await server.start();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error.message, /Open a Tabbit page/);
  } finally {
    await server.stop();
  }
});

test('returns a clear error when the content script is not active', async () => {
  const server = createBridgeServer({ port: 0 });
  await server.start();
  const { port } = server.address();

  try {
    await fetch(`http://127.0.0.1:${port}/__sync/tabbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookieHeader: 'token=1', referer: 'https://web.tabbit.ai/newtab' }),
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error.message, /page worker is not active/);
  } finally {
    await server.stop();
  }
});

test('times out when the Tabbit page does not complete a task', async () => {
  const server = createBridgeServer({ port: 0, taskTimeoutMs: 20 });
  await server.start();
  const { port } = server.address();

  try {
    await fetch(`http://127.0.0.1:${port}/__sync/tabbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookieHeader: 'token=1', referer: 'https://web.tabbit.ai/newtab' }),
    });
    await fetch(`http://127.0.0.1:${port}/__tabbit/ping`, { method: 'POST' });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.match(body.error.message, /Timed out/);
  } finally {
    await server.stop();
  }
});

test('streams thinking and content deltas in intercept mode', async () => {
  const server = createBridgeServer({ port: 0 });
  await server.start();
  const { port } = server.address();

  try {
    await fetch(`http://127.0.0.1:${port}/__sync/tabbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookieHeader: 'token=1', referer: 'https://web.tabbit.ai/newtab' }),
    });
    await fetch(`http://127.0.0.1:${port}/__tabbit/ping`, { method: 'POST' });

    const chatPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'GLM-5.2',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const taskResponse = await waitForTask(port);
    const task = await taskResponse.json();
    assert.equal(task.mode, 'intercept');
    assert.equal(task.stream, true);

    await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/${task.id}/chunk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: 'let me think' }),
    });
    await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/${task.id}/chunk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Hi there' }),
    });
    await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Hi there',
        thinking: 'let me think',
      }),
    });

    const chatResponse = await chatPromise;
    const raw = await chatResponse.text();
    assert.ok(raw.includes('"thinking":"let me think"'), 'stream includes thinking delta');
    assert.ok(raw.includes('"content":"Hi there"'), 'stream includes content delta');
    assert.ok(raw.endsWith('data: [DONE]\n\n'), 'stream ends with [DONE]');
  } finally {
    await server.stop();
  }
});

test('returns thinking and content in non-stream response', async () => {
  const server = createBridgeServer({ port: 0 });
  await server.start();
  const { port } = server.address();

  try {
    await fetch(`http://127.0.0.1:${port}/__sync/tabbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookieHeader: 'token=1', referer: 'https://web.tabbit.ai/newtab' }),
    });
    await fetch(`http://127.0.0.1:${port}/__tabbit/ping`, { method: 'POST' });

    const chatPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'GLM-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const taskResponse = await waitForTask(port);
    const task = await taskResponse.json();

    await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello!',
        thinking: 'greeting the user',
      }),
    });

    const chatResponse = await chatPromise;
    const chatBody = await chatResponse.json();
    assert.equal(chatResponse.status, 200);
    assert.equal(chatBody.choices[0].message.thinking, 'greeting the user');
    assert.equal(chatBody.choices[0].message.content, 'Hello!');
    assert.equal(chatBody.choices[0].finish_reason, 'stop');
  } finally {
    await server.stop();
  }
});

async function waitForTask(port) {
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/__tabbit/tasks/next`);
    if (response.status !== 204) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for queued task.');
}
