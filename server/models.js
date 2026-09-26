// The Claude models agents can run on, for the agent form's dropdown.
// Live from Anthropic's Models API when a key is set (so new models appear on their own), with a
// short built-in list as the fallback. Hive's agents run on Claude only: Managed Agents (skills,
// sandbox, vault credentials, approvals) is Claude's platform.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = process.env.DEFAULT_CLAUDE_MODEL || 'claude-opus-5';

// What we know about the main models: shown next to their names. Prices are list $ per million
// input / output tokens.
const NOTES = {
  'claude-opus-5': { note: 'Strong and careful; Hive’s default', price: '$5 / $25' },
  'claude-fable-5-1': { note: 'Most capable, for the hardest reconciliations; about 2× the cost', price: '$10 / $50' },
  'claude-fable-5': { note: 'Previous most-capable model', price: '$10 / $50' },
  'claude-opus-4-8': { note: 'Previous Opus', price: '$5 / $25' },
  'claude-sonnet-5': { note: 'Faster and cheaper; good for simpler, high-volume tasks', price: '$2 / $10' },
  'claude-haiku-4-5': { note: 'Fastest and cheapest; simple chats and lookups', price: '$1 / $5' },
};
const FALLBACK = [
  ['claude-opus-5', 'Claude Opus 5'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['claude-opus-4-8', 'Claude Opus 4.8'],
];

const withNotes = (id, name) => ({ id, name, ...(NOTES[id] ?? {}), default: id === DEFAULT_MODEL });

let cache = null; // { at, models }
export async function listModels({ client } = {}) {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.models;
  let models = FALLBACK.map(([id, name]) => withNotes(id, name));
  const hasKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (client || hasKey) {
    try {
      const api = client ?? new Anthropic();
      const live = [];
      for await (const m of api.models.list({ limit: 100 })) if (m.id.startsWith('claude-')) live.push(withNotes(m.id, m.display_name || m.id));
      if (live.length) {
        // Recommended ones first (in our order), then everything else as Anthropic lists it (newest first).
        const known = Object.keys(NOTES);
        models = [...known.map((id) => live.find((m) => m.id === id)).filter(Boolean), ...live.filter((m) => !known.includes(m.id))];
        if (!models.some((m) => m.id === DEFAULT_MODEL)) models.unshift(withNotes(DEFAULT_MODEL, DEFAULT_MODEL));
      }
    } catch (err) {
      console.error('[models] using the built-in list:', err.message);
    }
  }
  cache = { at: Date.now(), models };
  return models;
}
export const clearModelCache = () => (cache = null);
