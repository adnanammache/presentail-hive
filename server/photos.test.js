import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'hive-photos-')), 'hive.db');
const { run, get } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const { agentAvatar, imageType } = await import('./avatars.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

test('owners upload a photo; it replaces the robot face; bad files are refused', async (t) => {
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as') }), next())).use('/api', dashboardRouter()).use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const id = Number(run("INSERT INTO agents (name, title, color, api_token) VALUES ('Ledger', 'UAE Accountant', '#10b981', 'l')").lastInsertRowid);
  const owner = { 'x-as': 'owner@presentail.com' };
  await fetch(url('/me'), { headers: owner }); // first person: owner
  await fetch(url('/me'), { headers: { 'x-as': 'member@presentail.com' } });

  assert.equal((await agentAvatar(id)).type, 'image/png', 'robot face before any upload');
  assert.equal(imageType(Buffer.from('<svg onload=alert(1)>')), null);

  let res = await fetch(url(`/agents/${id}/photo`), { method: 'POST', headers: { 'x-as': 'member@presentail.com', 'Content-Type': 'image/png' }, body: PNG });
  assert.equal(res.status, 403, 'members cannot change photos');
  res = await fetch(url(`/agents/${id}/photo`), { method: 'POST', headers: { ...owner, 'Content-Type': 'image/png' }, body: Buffer.from('<html>not an image</html>') });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /PNG, JPEG or WebP/);

  res = await fetch(url(`/agents/${id}/photo`), { method: 'POST', headers: { ...owner, 'Content-Type': 'image/png' }, body: PNG });
  const agent = await res.json();
  assert.ok(agent.photo_version > 0);
  const img = await agentAvatar(id);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(img.body, PNG, 'the uploaded photo is served');

  await fetch(url(`/agents/${id}/photo`), { method: 'DELETE', headers: owner });
  assert.equal(get('SELECT photo_version FROM agents WHERE id = ?', id).photo_version, null);
  assert.notDeepEqual((await agentAvatar(id)).body, PNG, 'back to the robot face');
});
