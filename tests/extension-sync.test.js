import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTabbitSessionState } from '../src/extension/background.js';

const sessionUrl = 'https://web.tabbit.ai/session/ab12cf7a-544d-4a35-aacb-41d00ab1fee3';
const newtabUrl = 'https://web.tabbit.ai/newtab';

test('extracts the session id from a Tabbit tab URL', () => {
  const state = extractTabbitSessionState({
    url: sessionUrl,
    cookies: [{ name: 'token', value: 'abc' }],
  });

  assert.equal(state.chatSessionId, 'ab12cf7a-544d-4a35-aacb-41d00ab1fee3');
  assert.equal(state.cookieHeader, 'token=abc');
  assert.equal(state.referer, sessionUrl);
});

test('extracts cookies from the Tabbit newtab URL before a session exists', () => {
  const state = extractTabbitSessionState({
    url: newtabUrl,
    cookies: [{ name: 'token', value: 'abc' }],
  });

  assert.equal(state.chatSessionId, null);
  assert.equal(state.cookieHeader, 'token=abc');
  assert.equal(state.referer, newtabUrl);
});
