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
