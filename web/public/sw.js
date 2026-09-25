// Minimal service worker so Hive can be installed as an app. It does not cache:
// Hive is live data, so every request goes to the network as usual.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
