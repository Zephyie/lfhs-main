// LFHS Academic Hub - Offline Service Worker (Cache-first for app shell, network-only for APIs & PDF streams)
const CACHE_NAME = 'lfhs-cache-v28';
const APP_SHELL = [
  '/',
  '/index.html',
  '/antigravity.html',
  '/about.html',
  '/data/pdfs.js',
  '/pictures/campus.webp',
  '/pictures/campus-icon-192.webp',
  '/pictures/campus-icon-512.webp',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k.startsWith('lfhs-cache-') && k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  const reply = (data) => { if (port) port.postMessage(data); };

  if (event.data && event.data.type === 'PREPARE_OFFLINE') {
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then((cache) => cache.addAll(APP_SHELL))
        .then(() => reply({ ok: true }))
        .catch((error) => reply({ ok: false, error: error && error.message ? error.message : 'Cache preparation failed.' }))
    );
    return;
  }

  if (event.data && event.data.type === 'CHECK_OFFLINE') {
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then((cache) => Promise.all(APP_SHELL.map((url) => cache.match(url))))
        .then((entries) => reply({ ok: true, ready: entries.every(Boolean), cached: entries.filter(Boolean).length, total: APP_SHELL.length }))
        .catch((error) => reply({ ok: false, error: error && error.message ? error.message : 'Cache check failed.' }))
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only for all /api/ calls, non-GET requests, Range requests, PDFs, and remote manifest.json
  if (
    url.pathname.startsWith('/api/') ||
    event.request.method !== 'GET' ||
    event.request.headers.has('range') ||
    url.pathname.toLowerCase().endsWith('.pdf') ||
    url.pathname.toLowerCase().endsWith('/manifest.json')
  ) {
    return;
  }

  // Network-first for HTML navigation, falling back to cache if offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.open(CACHE_NAME).then((cache) =>
          cache.match(event.request).then((requestedPage) => requestedPage || cache.match('/index.html').then((page) => page || cache.match('/') || new Response(
            'LFHS Academic Hub is unavailable offline. Reconnect and try again.',
            { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
          )))
        );
      })
    );
    return;
  }

  // Stale-while-revalidate for successful same-origin and CORS static assets.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const fetchPromise = fetch(event.request).then(async (networkRes) => {
        if (networkRes && networkRes.status === 200 && (networkRes.type === 'basic' || networkRes.type === 'cors')) {
          try { await cache.put(event.request, networkRes.clone()); } catch (err) {
            // A full/unsupported cache must not prevent the network response from loading.
          }
        }
        return networkRes;
      }).catch(() => cached || Response.error());
      return cached || fetchPromise;
    })
  );
});
