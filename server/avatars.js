// PNG versions of the agents' robot faces (Slack can't show SVG).
import { Resvg } from '@resvg/resvg-js';
import { get } from './db.js';
import { botAvatarSvg } from '../shared/botface.js';

const cache = new Map(); // "name|color" → png
export function agentAvatarPng(agentId) {
  const agent = Number.isInteger(agentId) ? get('SELECT name, color FROM agents WHERE id = ?', agentId) : null;
  if (!agent) return null;
  const key = `${agent.name}|${agent.color}`;
  if (!cache.has(key)) cache.set(key, new Resvg(botAvatarSvg(agent.name, agent.color || '#6366f1', 256)).render().asPng());
  return cache.get(key);
}
