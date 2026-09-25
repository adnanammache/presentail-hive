// Minimal service worker so Hive can be installed as an app. It does not cache:
// Hive is live data, so every request goes to the network as usual.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Notifications: an agent needs you, finished, got stuck, or the daily brief is in.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Presentail Hive', body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Presentail Hive', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.startsWith(self.location.origin));
      if (win) return win.focus().then(() => win.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
