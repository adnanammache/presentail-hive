// PNG versions of the agents' robot faces (Slack can't show SVG).
// The renderer is a native module, loaded on first use: if it can't load, only avatars are
// affected (Slack then shows its default icon), never the rest of Hive.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, get, run } from './db.js';
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

// ---- uploaded photos ----
const photoDir = () => join(DATA_DIR, 'agent-photos');
const photoPath = (id) => join(photoDir(), `${id}.img`);
export const MAX_PHOTO = 3 * 1024 * 1024;

/** What an image really is, from its first bytes (never trust the file name or the header). */
export function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function saveAgentPhoto(agentId, buf) {
  if (!buf?.length) throw new Error('Empty file');
  if (buf.length > MAX_PHOTO) throw new Error('The photo must be under 3 MB');
  const type = imageType(buf);
  if (!type) throw new Error('Use a PNG, JPEG or WebP image');
  mkdirSync(photoDir(), { recursive: true });
  writeFileSync(photoPath(agentId), buf);
  run('UPDATE agents SET photo_type = ?, photo_version = ? WHERE id = ?', type, Date.now(), agentId);
  return get('SELECT photo_version FROM agents WHERE id = ?', agentId);
}

export function removeAgentPhoto(agentId) {
  rmSync(photoPath(agentId), { force: true });
  run('UPDATE agents SET photo_type = NULL, photo_version = NULL WHERE id = ?', agentId);
}

/** The agent's picture for /avatars/:id.png: its uploaded photo, or its robot face. */
export async function agentAvatar(agentId) {
  const agent = Number.isInteger(agentId) ? get('SELECT photo_type FROM agents WHERE id = ?', agentId) : null;
  if (!agent) return null;
  if (agent.photo_type) {
    try {
      return { type: agent.photo_type, body: readFileSync(photoPath(agentId)) };
    } catch {
      // file missing (e.g. a restored database without the photos folder): fall back to the face
    }
  }
  const png = await agentAvatarPng(agentId);
  return png ? { type: 'image/png', body: png } : null;
}

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

/** Cache-busting version for avatar URLs: changes when the photo or colour changes. */
export const avatarVersion = (agent) => `${agent.photo_version ?? ''}${agent.color ?? ''}`;
