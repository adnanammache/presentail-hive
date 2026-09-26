import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { listModels, clearModelCache, DEFAULT_MODEL } = await import('./models.js');

test('without a key: the built-in list, default first and marked', async () => {
  clearModelCache();
  const models = await listModels();
  assert.equal(models[0].id, DEFAULT_MODEL);
  assert.equal(models[0].default, true);
  assert.ok(models.every((m) => m.id.startsWith('claude-')));
  assert.match(models.find((m) => m.id === 'claude-haiku-4-5').price, /\$1/);
});

test("with a key: Anthropic's live list, recommended first, new models included", async () => {
  clearModelCache();
  const live = [
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
    { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
  ];
  const client = { models: { list: async function* () { yield* live; } } };
  const models = await listModels({ client });
  assert.deepEqual(models.map((m) => m.id), ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5']);
  assert.equal(models.find((m) => m.id === 'claude-opus-5-5').name, 'Claude Opus 5.5');

  const broken = { models: { list: async function* () { throw new Error('401'); } } };
  clearModelCache();
  assert.ok((await listModels({ client: broken })).length >= 4, 'falls back to the built-in list');
});
