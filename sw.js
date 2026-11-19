// 改版時把版本號 +1，使用者下次開啟就會更新快取
const CACHE = 'taiwan-radio-v1';
const ASSETS = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  // 逐一加入，單一檔案失敗不會讓整個 Service Worker 安裝失敗
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
  // 只處理同網域 GET；電台目錄、串流、hls.js 等外部請求一律直接走網路
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    // 頁面：先連網取最新，離線時用快取
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return res; }
        return caches.match('index.html').then(hit => hit || res);
      }).catch(() => caches.match('index.html'))
    );
    return;
  }

  // 靜態檔：先給快取，同時背景更新
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || net;
  }));
});
