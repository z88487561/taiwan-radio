// 改版時把版本號 +1，使用者下次開啟就會更新快取
const CACHE = 'ledger-v14';
const ASSETS = ['./', 'index.html', 'jsQR.js', 'tailwind.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  // cache:'reload' 繞過瀏覽器 HTTP 快取，確保這一版的所有檔案都是最新、彼此一致
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('ledger-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // 頁面：先連網取最新（只快取成功的回應），離線時用快取
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return res; }
      return caches.match('index.html').then(hit => hit || res);
    }).catch(() => caches.match('index.html')));
    return;
  }
  // 靜態檔：先給快取，同時背景更新
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || net;
  }));
});
