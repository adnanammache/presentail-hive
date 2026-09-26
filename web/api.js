import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export async function api(path, { method = 'GET', body, raw, type } = {}) {
  // `raw` sends a file (Blob) as-is with its content type; `body` sends JSON.
  const res = await fetch(`/api${path}`, {
    method,
    headers: raw ? { 'Content-Type': type || raw.type || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) {
    location.href = data.login; // session expired: back to "Continue with Google"
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- live updates over SSE ----
export const LiveContext = createContext(null);

/** Uploaded agent photos, looked up by agent id or name (every avatar in the app uses this). */
export const PhotosContext = createContext(null);
export const photoUrl = (a) => (a?.photo_version ? `/avatars/${a.id}.png?v=${a.photo_version}` : null);
export function usePhoto({ id, name } = {}) {
  const photos = useContext(PhotosContext);
  if (!photos) return null;
  return (id != null && photos.byId.get(Number(id))) || (name && photos.byName.get(name)) || null;
}

export function useLiveSource() {
  const listeners = useRef(new Set());
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      for (const fn of listeners.current) fn(event);
    };
    return () => es.close();
  }, []);
  const on = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);
  return { on, connected };
}

/** Fetch `path`, and refetch whenever a live event of one of `types` arrives. */
export function useApi(path, types = []) {
  const live = useContext(LiveContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const typesKey = types.join(',');
  const reload = useCallback(() => {
    if (!path) return Promise.resolve();
    return api(path).then(setData, (e) => setError(e.message));
  }, [path]);
  useEffect(() => {
    setData(null);
    reload();
  }, [reload]);
  useEffect(() => {
    if (!typesKey || !live) return;
    let timer;
    return live.on((event) => {
      if (!typesKey.split(',').includes(event.type)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    });
  }, [live, reload, typesKey]);
  return { data, error, reload, setData };
}

// ---- time helpers (SQLite stores UTC as "YYYY-MM-DD HH:MM:SS") ----
export const toDate = (s) => (s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : null);

export function ago(s) {
  const d = toDate(s);
  if (!d) return 'never';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.round(sec / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function until(s) {
  const d = toDate(s);
  if (!d) return '—';
  const sec = Math.round((d.getTime() - Date.now()) / 1000);
  if (sec < 60) return 'any moment';
  if (sec < 3600) return `in ${Math.round(sec / 60)}m`;
  if (sec < 86400) return `in ${Math.round(sec / 3600)}h`;
  return `in ${Math.round(sec / 86400)}d`;
}

// ---- calendar dates (YYYY-MM-DD, Dubai) ----
const dayUTC = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
/** "28 Oct 2026" */
export const fmtDay = (s) => {
  if (!s) return '';
  const d = dayUTC(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
export const addDaysISO = (s, n) => new Date(dayUTC(s).getTime() + n * 86400000).toISOString().slice(0, 10);
export const daysBetweenISO = (a, b) => Math.round((dayUTC(b) - dayUTC(a)) / 86400000);
export const dubaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());

/** Format a timestamp; pass a timezone to show it in that zone (e.g. a workflow's own timezone). */
export const fmtDateTime = (s, timeZone) =>
  toDate(s)?.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }) ?? '—';
