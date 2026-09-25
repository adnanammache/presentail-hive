// PNG versions of the agents' robot faces (Slack can't show SVG).
// The renderer is a native module, loaded on first use: if it can't load, only avatars are
// affected (Slack then shows its default icon), never the rest of Hive.
import { get } from './db.js';
import { botAvatarSvg } from '../shared/botface.js';

let Resvg;
const renderer = async () => {
  if (Resvg === undefined) {
    try {
      ({ Resvg } = await import('@resvg/resvg-js'));
    } catch (err) {
      console.error('[avatars] PNG renderer unavailable:', err.message);
      Resvg = null;
    }
  }
  return Resvg;
};

const cache = new Map(); // "name|color" → png
export async function agentAvatarPng(agentId) {
  const agent = Number.isInteger(agentId) ? get('SELECT name, color FROM agents WHERE id = ?', agentId) : null;
  if (!agent) return null;
  const key = `${agent.name}|${agent.color}`;
  if (!cache.has(key)) {
    const R = await renderer();
    if (!R) return null;
    cache.set(key, new R(botAvatarSvg(agent.name, agent.color || '#6366f1', 256)).render().asPng());
  }
  return cache.get(key);
}
