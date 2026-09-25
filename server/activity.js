import { run } from './db.js';
import { emit } from './events.js';

export function logActivity(agentId, kind, text) {
  run('INSERT INTO activity (agent_id, kind, text) VALUES (?, ?, ?)', agentId ?? null, kind, text);
  emit('activity');
}
