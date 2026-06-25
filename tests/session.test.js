import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCookieHeader, parseTabbitSessionId } from '../src/shared/session.js';

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
