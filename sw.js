// 改版時把版本號 +1
const CACHE = 'taiwan-radio-v6';
const ASSETS = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.json', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // 只清自己的舊版本（同網域下其他專案的快取不要動）
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('taiwan-radio-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // 只處理同網域 GET；電台目錄、串流、hls.js 等外部請求直接走網路
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.headers.has('range')) return;
  const isPage = req.mode === 'navigate';

  // 網路優先（每次都拿最新檔案，不用瀏覽器 HTTP 快取），離線時才用 Service Worker 快取
  e.respondWith(
    fetch(isPage ? req.url : req, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(isPage ? 'index.html' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(isPage ? 'index.html' : req, { ignoreSearch: true }).then(hit => hit || Response.error()))
  );
});
