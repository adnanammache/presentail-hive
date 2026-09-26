// Where a message lands in an open chat when it arrives live.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let addMessage;
before(async () => {
  vite = await createServer({ configFile: new URL('../vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
  ({ addMessage } = await vite.ssrLoadModule('/components/Chat.jsx'));
});
after(() => vite?.close());

const msg = (id, created_at) => ({ id, created_at });

test('a live message goes at the end; a late one where it was said; duplicates are ignored', () => {
  const ms = [msg(1, '2026-09-26 12:47:00'), msg(2, '2026-09-26 12:49:00')];
  assert.deepEqual(addMessage(ms, msg(3, '2026-09-26 12:49:05')).map((m) => m.id), [1, 2, 3]);
  assert.deepEqual(addMessage(ms, msg(3, '2026-09-26 12:47:30')).map((m) => m.id), [1, 3, 2]);
  assert.deepEqual(addMessage(ms, msg(3, '2026-09-26 12:49:00')).map((m) => m.id), [1, 2, 3], 'same second: after');
  assert.equal(addMessage(ms, msg(2, '2026-09-26 12:49:00')), ms);
  assert.equal(addMessage(null, msg(1, 'x')), null, 'not loaded yet');
});
