/* NOVA · service worker — deixa o app abrir rápido e funcionar sem internet.
   Ao publicar uma versão nova, ele baixa sozinho e o app avisa "Nova versão". */
const VERSION = 'nova-2026-11-04-1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-64.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'atualizar') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;                                  // salvar dados: sempre direto na internet
  if (url.pathname.startsWith('/api/')) return;                       // IA: nunca guardar
  if (/supabase\.co$/.test(url.hostname)) return;                     // banco e login: nunca guardar

  // Página do app: tenta a internet (versão mais nova); sem internet, usa a cópia guardada
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(VERSION); c.put('/index.html', fresh.clone());
        return fresh;
      } catch (err) {
        return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Ícones, fontes e biblioteca do Supabase: usa a cópia e atualiza por trás
  const cacheable = url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$|cdn\.jsdelivr\.net$/.test(url.hostname);
  if (!cacheable) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION), hit = await c.match(req);
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});

/* Toque na notificação: abre (ou traz para frente) o app */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action, data = e.notification.data || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find(c => new URL(c.url).origin === location.origin);
    if (client) { await client.focus(); client.postMessage({ tipo: 'notificacao', action, key: data.key }); }
    else await self.clients.openWindow('/' + (data.key ? '?abrir=' + encodeURIComponent(data.key) : '') + '#today');
  })());
});

/* Pronto para receber avisos com o app fechado (Web Push) quando o servidor for ligado */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'NOVA', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NOVA', {
    body: d.body || '', tag: d.tag, data: { key: d.key }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    requireInteraction: !!d.persistent,
  }));
});
