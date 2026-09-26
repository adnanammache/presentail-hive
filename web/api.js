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
/** Refetch the photos now, e.g. right after an upload (don't wait for the live event, which may be down). */
export const useReloadPhotos = () => useContext(PhotosContext)?.reload ?? (() => {});

/**
 * The live event stream. The browser retries a dropped connection by itself, but gives up for good
 * when the server answers with an error (a restart mid-deploy, or a sign-in that expired), which left
 * Hive stuck on "Reconnecting…". So: reopen a closed stream with backoff, send people to sign in if
 * their session ended, and after any reconnect tell every view to refetch what it may have missed.
 */
export function useLiveSource() {
  const listeners = useRef(new Set());
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let es;
    let retry;
    let attempt = 0;
    let dropped = false;
    let stopped = false;
    const broadcast = (event) => {
      for (const fn of listeners.current) fn(event);
    };
    const open = () => {
      clearTimeout(retry);
      es?.close();
      es = new EventSource('/api/events');
      es.onopen = () => {
        setConnected(true);
        attempt = 0;
        if (dropped) broadcast({ type: '*' }); // catch up on anything missed while disconnected
        dropped = false;
      };
      es.onerror = () => {
        setConnected(false);
        dropped = true;
        if (es.readyState !== EventSource.CLOSED || stopped) return; // the browser is retrying by itself
        // Closed for good: is it the sign-in? Otherwise try again, a little later each time.
        fetch('/api/me')
          .then(async (res) => {
            const data = res.status === 401 ? await res.json().catch(() => ({})) : null;
            if (data?.login) location.href = data.login;
          })
          .catch(() => {})
          .finally(() => {
            if (!stopped) retry = setTimeout(open, Math.min(30000, 1000 * 2 ** attempt++));
          });
      };
      es.onmessage = (e) => broadcast(JSON.parse(e.data));
    };
    // Coming back to the tab or the network: reconnect now rather than waiting out the backoff.
    const wake = () => document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED && ((attempt = 0), open());
    open();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
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
      if (event.type !== '*' && !typesKey.split(',').includes(event.type)) return;
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (s, { year = true } = {}) => {
  if (!s) return '';
  const d = dayUTC(s);
  return Number.isNaN(d.getTime()) ? s : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
};
export const addDaysISO = (s, n) => new Date(dayUTC(s).getTime() + n * 86400000).toISOString().slice(0, 10);
export const daysBetweenISO = (a, b) => Math.round((dayUTC(b) - dayUTC(a)) / 86400000);
export const dubaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());

/** Format a timestamp; pass a timezone to show it in that zone (e.g. a workflow's own timezone). */
export const fmtDateTime = (s, timeZone) =>
  toDate(s)?.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }) ?? '—';
