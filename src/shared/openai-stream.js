import { randomUUID } from 'node:crypto';

export function tabbitChunkToOpenAIDelta(rawLine) {
  const line = rawLine.trim();
  if (!line || line === '[DONE]') return '';

  const payload = JSON.parse(line.startsWith('data:') ? line.slice(5).trim() : line);
  return payload.content ?? payload.delta ?? payload.text ?? '';
}

export function createOpenAIStreamChunk({ model, content, thinking, finishReason = null }) {
  const delta = {};
  if (content) delta.content = content;
  if (thinking) delta.thinking = thinking;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function finalizeOpenAIResponse({ model, text, thinking, finishReason }) {
  const message = { role: 'assistant' };
  if (text) message.content = text;
  if (thinking) message.thinking = thinking;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason ?? 'stop',
        message,
      },
    ],
  };
}

export function createOpenAIError(message, type = 'invalid_request_error') {
  return { error: { message, type } };
}
