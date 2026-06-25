import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeOpenAIResponse, tabbitChunkToOpenAIDelta, createOpenAIStreamChunk } from '../src/shared/openai-stream.js';

test('maps a Tabbit chunk into an OpenAI delta', () => {
  assert.equal(tabbitChunkToOpenAIDelta('{"content":"hello"}'), 'hello');
});

test('maps a Tabbit SSE data line into an OpenAI delta', () => {
  assert.equal(tabbitChunkToOpenAIDelta('data: {"content":"hello"}'), 'hello');
});

test('builds a final OpenAI response body', () => {
  const response = finalizeOpenAIResponse({
    model: 'GLM-5.2',
    text: 'hello world',
  });

  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.content, 'hello world');
  assert.equal(response.choices[0].finish_reason, 'stop');
});

test('builds a final response with thinking', () => {
  const response = finalizeOpenAIResponse({
    model: 'GLM-5.2',
    text: 'answer',
    thinking: 'let me think',
  });

  assert.equal(response.choices[0].message.thinking, 'let me think');
  assert.equal(response.choices[0].finish_reason, 'stop');
});

test('creates a stream chunk with thinking delta', () => {
  const chunk = createOpenAIStreamChunk({ model: 'GLM-5.2', thinking: 'reasoning here' });
  assert.equal(chunk.choices[0].delta.thinking, 'reasoning here');
  assert.equal(chunk.choices[0].delta.content, undefined);
});

test('creates a stream chunk with finish_reason', () => {
  const chunk = createOpenAIStreamChunk({ model: 'GLM-5.2', finishReason: 'stop' });
  assert.equal(chunk.choices[0].delta.content, undefined);
  assert.equal(chunk.choices[0].finish_reason, 'stop');
});
