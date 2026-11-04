// =====================================================================
// NOVA · /api/push-enviar — chamado pelo Supabase a cada minuto.
// Pega os avisos que venceram e manda a notificação para os celulares.
//
// Variáveis na Vercel: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET,
//                      SUPABASE_URL, SUPABASE_ANON_KEY
// =====================================================================
const webpush = require('web-push');

const rpc = async (fn, args) => {
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_ANON_KEY },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
};

const NAMES = { done: 'Concluir', snooze: 'Adiar 30 min', open: 'Abrir' };

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.authorization || '') !== 'Bearer ' + secret) return res.status(401).json({ error: 'negado' });
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(503).json({ error: 'faltam variaveis' });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://nova-nine-ivory.vercel.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  let avisos;
  try { avisos = await rpc('nova_push_pendentes', { p_segredo: secret }); }
  catch (e) { console.error(e); return res.status(502).json({ error: 'supabase' }); }

  let enviados = 0, falhas = 0, removidos = 0;
  const jobs = [];
  for (const a of avisos || []) {
    const payload = JSON.stringify({
      title: a.titulo, body: a.corpo || '', tag: a.chave, key: a.item || '', importante: !!a.importante,
      actions: (a.acoes || []).filter(x => NAMES[x]).slice(0, 2).map(x => ({ action: x, title: NAMES[x] })),
      ts: Date.now(),
    });
    for (const s of a.inscricoes || []) {
      jobs.push(webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' })
        .then(() => { enviados++; })
        .catch(async err => {
          falhas++;
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {   // aparelho desinstalou ou bloqueou
            try { await rpc('nova_push_remover', { p_segredo: secret, p_endpoint: s.endpoint }); removidos++; } catch (e) { }
          } else console.error('push', err && err.statusCode, err && (err.body || err.message));
        }));
    }
  }
  await Promise.all(jobs);
  return res.status(200).json({ avisos: (avisos || []).length, enviados, falhas, removidos });
};
