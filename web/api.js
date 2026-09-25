import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- live updates over SSE ----
export const LiveContext = createContext(null);

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

/** Format a timestamp; pass a timezone to show it in that zone (e.g. a workflow's own timezone). */
export const fmtDateTime = (s, timeZone) =>
  toDate(s)?.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }) ?? '—';
