const CACHE = 'controlhorari-static-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/offline.html', '/icon-192.png', '/icon-512.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('controlhorari-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate' && event.request.method === 'GET') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Show a generic notice if a payload is malformed. */ }
  const styles = {
    success: { symbol: '✅', icon: '/notification-success.png' },
    error: { symbol: '❌', icon: '/notification-error.png' },
    warning: { symbol: '⚠️', icon: '/notification-warning.png' },
    info: { symbol: 'ℹ️', icon: '/icon-192.png' },
  };
  const style = Object.hasOwn(styles, data.level) ? styles[data.level] : styles.info;
  event.waitUntil(self.registration.showNotification(`${style.symbol} ${data.title || 'Control Horari'}`, {
    body: data.body || 'Hay una novedad en tu fichaje.',
    icon: style.icon, tag: data.tag || 'controlhorari',
    data: { url: '/?view=notifications' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL('/?view=notifications', self.location.origin).href;
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(url); return existing.focus(); }
    return clients.openWindow(url);
  })());
});
