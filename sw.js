/* NOVA · service worker — deixa o app abrir rápido e funcionar sem internet.
   Ao publicar uma versão nova, ele baixa sozinho e o app avisa "Nova versão". */
const VERSION = 'nova-2026-11-04-2';
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

/* Notificação chegando do servidor (app fechado): som, vibração e botões */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'NOVA', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NOVA', {
    body: d.body || '',
    tag: d.tag || 'nova-' + Date.now(),
    renotify: true,                        // toca de novo mesmo se já houver uma igual
    data: { key: d.key || '', title: d.title || '', body: d.body || '' },
    icon: '/icons/icon-192.png',           // ícone grande (como a foto no WhatsApp)
    badge: '/icons/badge-96.png',          // ícone pequeno na barra de status (Android)
    vibrate: d.importante ? [250, 100, 250, 100, 250] : [180, 80, 180],
    timestamp: d.ts || Date.now(),
    requireInteraction: !!d.importante,    // importantes ficam na tela até você tocar
    silent: false,
    actions: Array.isArray(d.actions) ? d.actions.slice(0, 2) : [],
  }));
});

/* Toque na notificação ou num dos botões */
self.addEventListener('notificationclick', e => {
  const action = e.action, data = e.notification.data || {};
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = all.filter(c => new URL(c.url).origin === location.origin);
    const visible = mine.find(c => c.visibilityState === 'visible');

    // "Adiar 30 min" com o app fechado: o servidor agenda de novo, sem abrir nada
    if (action === 'snooze' && !visible) {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        const r = sub && await fetch('/api/push-acao', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'snooze', endpoint: sub.endpoint, key: data.key, title: data.title, body: data.body }) });
        await self.registration.showNotification('⏰ Combinado!', { body: r && r.ok ? 'Vou lembrar de novo em 30 minutos.' : 'Não consegui adiar. Abra o NOVA para remarcar.', tag: 'nova-adiado', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', silent: true });
      } catch (err) { }
      return;
    }
    const client = visible || mine[0];
    if (client) {
      await client.focus().catch(() => {});
      client.postMessage({ tipo: 'notificacao', action: action || 'open', key: data.key });
      return;
    }
    const q = data.key ? (action === 'done' ? '?acao=done&abrir=' : '?abrir=') + encodeURIComponent(data.key) : '';
    await self.clients.openWindow('/' + q + '#today');
  })());
});
