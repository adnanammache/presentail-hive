// Phone / desktop notifications through Web Push (works for Hive installed on the home screen).
// Keys are generated once and kept in the database, so there's nothing to configure.
import webpush from 'web-push';
import { all, get, run } from './db.js';

let keys = null;
export function vapidKeys() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const row = get("SELECT value FROM app_meta WHERE key = 'vapid'");
    keys = row ? JSON.parse(row.value) : webpush.generateVAPIDKeys();
    if (!row) run("INSERT INTO app_meta (key, value) VALUES ('vapid', ?)", JSON.stringify(keys));
  }
  return keys;
}

const subject = () => {
  const url = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  return url.startsWith('https://') ? url : 'mailto:hive@localhost';
};

export function saveSubscription(sub, user) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid push subscription');
  run(
    `INSERT INTO push_subscriptions (endpoint, keys, user) VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, user = excluded.user`,
    sub.endpoint, JSON.stringify(sub.keys), user ?? null,
  );
}

export const removeSubscription = (endpoint) => run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
export const subscriptionCount = () => get('SELECT COUNT(*) AS n FROM push_subscriptions').n;

let sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
export const setPushSender = (fn) => (sender = fn); // tests

/** Send to every subscribed device. Dead subscriptions are removed. */
export const pushToAll = (msg) => pushTo(all('SELECT * FROM push_subscriptions'), msg);

/** Send to one person's devices (subscriptions saved while they were signed in). */
export const pushToUser = (email, msg) => pushTo(all('SELECT * FROM push_subscriptions WHERE user = ?', String(email || '').toLowerCase()), msg);

async function pushTo(subs, { title, body, url = '/', tag }) {
  if (!subs.length) return { sent: 0 };
  const { publicKey, privateKey } = vapidKeys();
  const payload = JSON.stringify({ title, body: body?.slice(0, 240), url, tag });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, {
          vapidDetails: { subject: subject(), publicKey, privateKey },
          TTL: 60 * 60 * 12,
          urgency: 'high',
        });
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(s.endpoint);
        else console.error('[push]', err.statusCode ?? '', err.message);
      }
    }),
  );
  return { sent };
}
