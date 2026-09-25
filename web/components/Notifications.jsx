import { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;

/** Settings: turn phone/desktop notifications on for this device. */
export function NotificationSettings() {
  const { data, reload } = useApi('/push');
  const [sub, setSub] = useState(undefined);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!supported()) return setSub(null);
    navigator.serviceWorker.getRegistration().then((reg) => (reg ? reg.pushManager.getSubscription() : null)).then(setSub, () => setSub(null));
  }, []);

  const enable = async () => {
    setMsg('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setMsg('Notifications are blocked for Hive. Allow them in your browser or phone settings.');
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.public_key) });
      await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
      setSub(s);
      reload();
      setMsg('On. Sending a test…');
      await api('/push/test', { method: 'POST' });
      setMsg('On for this device.');
    } catch (err) {
      setMsg(err.message);
    }
  };
  const disable = async () => {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe().catch(() => {});
    setSub(null);
    reload();
    setMsg('Off for this device.');
  };

  return (
    <section className="card settings-note">
      <h2>Notifications on this device</h2>
      <p className="muted">Get a notification when an agent needs your approval, finishes, gets stuck, or when the daily brief arrives. Tapping it opens the right page.</p>
      {!supported() ? (
        isIOS() && !standalone() ? (
          <p className="notice warn">On iPhone, first add Hive to your Home Screen (Share → Add to Home Screen), then open it from there and come back here.</p>
        ) : (
          <p className="muted small">This browser doesn't support notifications.</p>
        )
      ) : sub === undefined ? null : sub ? (
        <div className="row-gap">
          <span className="badge badge-green">On for this device</span>
          <button className="btn btn-sm" onClick={() => api('/push/test', { method: 'POST' }).then(() => setMsg('Sent.'))}>
            Send a test
          </button>
          <button className="btn btn-sm" onClick={disable}>
            Turn off
          </button>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={enable} disabled={!data}>
          Turn on notifications
        </button>
      )}
      {msg && <p className="small muted">{msg}</p>}
      {data && <p className="small muted">{data.devices} device{data.devices === 1 ? '' : 's'} signed up.</p>}
    </section>
  );
}

const ZONES = ['Asia/Dubai', 'Asia/Beirut', 'Asia/Nicosia', 'Europe/London', 'UTC'];
const DAYS = [
  ['1-5', 'Mon–Fri'],
  ['1-6', 'Mon–Sat'],
  ['*', 'Every day'],
];

/** Settings: when the daily brief goes out. */
export function BriefSettings() {
  const { data, setData } = useApi('/brief', ['brief']);
  const [err, setErr] = useState('');
  if (!data) return null;
  const c = data.config;
  const save = (patch) =>
    api('/brief/config', { method: 'PUT', body: patch }).then(
      (r) => (setErr(''), setData({ ...data, ...r })),
      (e) => setErr(e.message),
    );
  return (
    <section className="card settings-note">
      <h2>Daily brief</h2>
      <p className="muted">Your Chief of Staff posts a brief to the dashboard, their Inbox thread, Slack and your notifications.</p>
      <div className="brief-config">
        <label className="check">
          <input type="checkbox" checked={c.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Send automatically
        </label>
        <label>
          At <input type="time" value={c.time} onChange={(e) => e.target.value && save({ time: e.target.value })} disabled={!c.enabled} />
        </label>
        <select value={c.days} onChange={(e) => save({ days: e.target.value })} disabled={!c.enabled} aria-label="Days">
          {DAYS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={c.timezone} onChange={(e) => save({ timezone: e.target.value })} disabled={!c.enabled} aria-label="Time zone">
          {[...new Set([c.timezone, ...ZONES])].map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </div>
      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}
    </section>
  );
}
