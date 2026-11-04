// =====================================================================
// NOVA · /api/push-acao — botão "Adiar 30 min" tocado na notificação
// com o app fechado. Agenda o mesmo aviso de novo para daqui a 30 minutos.
// =====================================================================
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.op !== 'snooze' || typeof b.endpoint !== 'string' || !b.endpoint.startsWith('https://')) return res.status(400).json({ error: 'pedido' });
  const { SUPABASE_URL, SUPABASE_ANON_KEY, CRON_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !CRON_SECRET) return res.status(503).json({ error: 'faltam variaveis' });
  const r = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/nova_push_adiar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    body: JSON.stringify({ p_segredo: CRON_SECRET, p_endpoint: b.endpoint.slice(0, 1000), p_item: String(b.key || '').slice(0, 200),
      p_titulo: String(b.title || 'Lembrete').slice(0, 200), p_corpo: String(b.body || '').slice(0, 400) }),
  });
  return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
};
