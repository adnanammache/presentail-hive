// Small pure helpers for the agent workspace: storage scoped to the signed-in person, date groups for
// the conversation history, and a CSV reader for file previews. No React here, so they're easy to test.
import { toDate } from '../api.js';

export const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null || v === '') localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode: just not kept */
    }
  },
};

// Everything kept in this browser is per person, so a shared computer never shows one person's
// drafts or last conversation to another.
const who = (email) => String(email || 'anon').toLowerCase();
export const lastChatKey = (email, agentId) => `hive:lastChat:${who(email)}:${agentId}`;
export const draftKey = (email, agentId, chatId) => `hive:chatDraft:${who(email)}:${agentId}:${chatId ?? 'new'}`;
export const legacyDraftKey = (agentId, chatId) => `hive:chatDraft:${agentId}:${chatId ?? 'new'}`;

/** A draft as stored: text plus file references ({ ref, filename, quote }). Older drafts were plain text. */
export function readDraft(raw) {
  if (!raw) return { text: '', refs: [] };
  if (raw.startsWith('{"v":1')) {
    try {
      const d = JSON.parse(raw);
      return { text: String(d.text ?? ''), refs: Array.isArray(d.refs) ? d.refs.filter((r) => r && typeof r.ref === 'string').slice(0, 5) : [] };
    } catch {
      return { text: '', refs: [] };
    }
  }
  return { text: raw, refs: [] };
}
export const writeDraft = ({ text, refs }) => (!text && !refs?.length ? null : JSON.stringify({ v: 1, text, refs: refs ?? [] }));

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** History groups: Today, Yesterday, Previous 7 days, Previous 30 days, then by month. */
export function groupLabel(s, now = new Date()) {
  const d = toDate(s);
  if (!d) return 'Older';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** A row's time: the clock today, the weekday this week, else the date. */
export function rowTime(s, now = new Date()) {
  const d = toDate(s);
  if (!d) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** Rows in order, each with the group it starts (if any). */
export function withGroups(chats, filter, now = new Date()) {
  let last = null;
  return chats.map((c) => {
    const label = groupLabel(filter === 'archived' ? c.archived_at : c.last_message_at ?? c.created_at, now);
    const starts = label !== last ? label : null;
    last = label;
    return { chat: c, group: starts };
  });
}

export const RESURFACED = { message: 'new message', mention: 'you were mentioned', request: 'new request for you' };

/** CSV/TSV → rows of cells (quotes, doubled quotes and newlines in quotes), at most `limit` rows. */
export function parseCsv(text, { delimiter, limit = 500 } = {}) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const sep = delimiter ?? (src.split('\n', 1)[0].split('\t').length > src.split('\n', 1)[0].split(',').length ? '\t' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > limit) break;
    } else cell += ch;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  const truncated = rows.length > limit;
  return { rows: rows.slice(0, limit), truncated };
}
