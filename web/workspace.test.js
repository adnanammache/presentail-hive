// The agent workspace's pure helpers: history date groups, drafts kept per person (with file
// references), and the CSV reader behind file previews.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let util;
before(async () => {
  vite = await createServer({ configFile: new URL('../vite.config.js', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
  util = await vite.ssrLoadModule('/components/chatUtil.js');
});
after(() => vite?.close());

const now = new Date(2026, 8, 26, 15, 0); // 26 Sep 2026, 15:00 local
const sql = (d) => d.toISOString().replace('T', ' ').slice(0, 19); // stored as UTC "YYYY-MM-DD HH:MM:SS"
const daysAgo = (n, h = 10) => sql(new Date(2026, 8, 26 - n, h, 0));

test('history groups: Today, Yesterday, the last week and month, then by month', () => {
  const { groupLabel } = util;
  assert.equal(groupLabel(daysAgo(0), now), 'Today');
  assert.equal(groupLabel(daysAgo(1), now), 'Yesterday');
  assert.equal(groupLabel(daysAgo(5), now), 'Previous 7 days');
  assert.equal(groupLabel(daysAgo(20), now), 'Previous 30 days');
  assert.match(groupLabel(daysAgo(60), now), /July/);
  assert.equal(groupLabel(null, now), 'Older');
});

test('rows start a group only when it changes; archived rows group by archive time', () => {
  const chats = [
    { id: 1, last_message_at: daysAgo(0), archived_at: daysAgo(3) },
    { id: 2, last_message_at: daysAgo(0), archived_at: daysAgo(3) },
    { id: 3, last_message_at: daysAgo(1), archived_at: daysAgo(40) },
  ];
  assert.deepEqual(util.withGroups(chats, 'active', now).map((r) => r.group), ['Today', null, 'Yesterday']);
  const archived = util.withGroups(chats, 'archived', now).map((r) => r.group);
  assert.deepEqual(archived.slice(0, 2), ['Previous 7 days', null]);
});

test('drafts are per person and keep file references; older plain-text drafts still load', () => {
  const { draftKey, lastChatKey, readDraft, writeDraft } = util;
  assert.notEqual(draftKey('a@x.com', 7, 2), draftKey('b@x.com', 7, 2));
  assert.equal(draftKey('A@X.com', 7, null), 'hive:chatDraft:a@x.com:7:new');
  assert.equal(lastChatKey('a@x.com', 7), 'hive:lastChat:a@x.com:7');
  const refs = [{ ref: 'chat:4', filename: 'Split.csv', quote: 'Branch A' }];
  assert.deepEqual(readDraft(writeDraft({ text: 'Is this right?', refs })), { text: 'Is this right?', refs });
  assert.equal(writeDraft({ text: '', refs: [] }), null, 'an empty draft is removed');
  assert.deepEqual(readDraft('plain old draft'), { text: 'plain old draft', refs: [] });
  assert.deepEqual(readDraft('{"v":1,"text":"x","refs":[{"nope":1}]}').refs, [], 'malformed references are dropped');
  assert.deepEqual(readDraft(null), { text: '', refs: [] });
});

test('CSV preview: quotes, doubled quotes, newlines in cells, tabs, and a row limit', () => {
  const { parseCsv } = util;
  const { rows } = parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",3\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
  const many = parseCsv(Array.from({ length: 20 }, (_, i) => `r${i}`).join('\n'), { limit: 5 });
  assert.equal(many.rows.length, 5);
  assert.equal(many.truncated, true);
  assert.deepEqual(parseCsv('﻿h1,h2\r\n1,2\r\n').rows, [['h1', 'h2'], ['1', '2']]);
});
