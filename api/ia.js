// =====================================================================
// NOVA · /api/ia — Assistente de agenda (roda na Vercel, não no navegador)
// A chave da OpenAI fica guardada aqui, nas variáveis da Vercel.
//
// Variáveis de ambiente (Vercel > Settings > Environment Variables):
//   OPENAI_API_KEY     (obrigatória)  chave da OpenAI
//   OPENAI_MODEL       (opcional)     padrão: gpt-5-mini
//   SUPABASE_URL       (recomendada)  ex.: https://xxxx.supabase.co
//   SUPABASE_ANON_KEY  (recomendada)  chave anon public
// Com SUPABASE_URL e SUPABASE_ANON_KEY preenchidas, só quem está logado
// no NOVA consegue usar a IA (evita que estranhos gastem seus créditos).
// =====================================================================

const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const LIMIT_PER_HOUR = 60;            // pedidos por pessoa por hora
const hits = new Map();               // contador simples por instância

const nullable = t => ({ type: [t, 'null'] });
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'actions'],
  properties: {
    reply: { type: 'string', description: 'Resposta curta e simpática em português do Brasil para mostrar ao usuário.' },
    actions: {
      type: 'array', description: 'Mudanças a fazer na agenda. Vazio quando for só uma pergunta.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['op', 'ref', 'type', 'title', 'date', 'time', 'duration', 'reminder', 'priority', 'repeat', 'project', 'notes'],
        properties: {
          op: { type: 'string', enum: ['create', 'update', 'complete', 'delete'] },
          ref: { ...nullable('string'), description: 'Para update/complete/delete: o campo "ref" exato do item da agenda. null em create.' },
          type: { type: ['string', 'null'], enum: ['event', 'task', 'reminder', null], description: 'event = compromisso com hora (consulta, reunião, visita); task = algo a fazer; reminder = só um aviso.' },
          title: { ...nullable('string'), description: 'Título curto, sem data/hora. Ex.: "Consulta", "Reunião com o contador".' },
          date: { ...nullable('string'), description: 'AAAA-MM-DD.' },
          time: { ...nullable('string'), description: 'HH:MM (24h).' },
          duration: { ...nullable('integer'), description: 'Duração em minutos.' },
          reminder: { ...nullable('integer'), description: 'Minutos de antecedência do aviso (0 = na hora, 1440 = 1 dia antes).' },
          priority: { ...nullable('integer'), description: '1 importante, 2 alta, 3 normal, 4 baixa.' },
          repeat: { ...nullable('string'), description: 'Repetição em português simples: "todo dia", "dias úteis", "toda segunda", "toda segunda e quarta", "todo dia 10", "toda semana", "todo mês", "a cada 3 dias". null se não repete.' },
          project: { ...nullable('string'), description: 'Nome de um projeto existente, se o usuário citar.' },
          notes: { ...nullable('string'), description: 'Detalhes extras (endereço, observações).' },
        },
      },
    },
  },
};

function systemPrompt(ctx) {
  return `Você é o assistente de agenda do app NOVA. O usuário fala português do Brasil, muitas vezes por voz e de forma informal ("agenda aí", "anota aí", "marca pra mim").

Hoje é ${ctx.weekday}, ${ctx.today}. Agora são ${ctx.now} (fuso ${ctx.timezone || 'America/Sao_Paulo'}).
Dia útil do usuário: ${ctx.dayStart} às ${ctx.dayEnd}${ctx.lunch ? `, almoço ${ctx.lunch}` : ''}. Lembrete padrão: ${ctx.defaultReminder} min antes.
Projetos: ${(ctx.projects || []).join(', ') || 'nenhum'}.

REGRAS
- Seu trabalho: criar, remarcar, concluir ou excluir itens, e responder perguntas sobre a agenda (dias livres, o que tem em tal dia, conflitos).
- Datas: "dia 13" = o próximo dia 13 a partir de hoje (se já passou neste mês, é no mês seguinte). "sexta" = a próxima sexta (se hoje é sexta e a hora ainda não passou, é hoje). "amanhã", "depois de amanhã", "semana que vem" = calcule a partir de hoje. Sempre devolva AAAA-MM-DD.
- Horas: "às 14", "14h", "duas da tarde" = 14:00. "8 da noite" = 20:00. Sem manhã/tarde e entre 1 e 6, prefira a tarde (ex.: "às 3" = 15:00). "meio-dia" = 12:00.
- Consulta, reunião, exame, visita, entrevista, dentista, médico, audiência, culto, viagem e afins são "event" (compromisso). Coisas a fazer ("pagar", "enviar", "ligar", "comprar") são "task". "Me lembra de..." vira "task" com reminder 0 quando tiver hora.
- Duração padrão: compromisso 60 min, tarefa 30 min, se o usuário não disser.
- Lembrete: use o que o usuário pedir; senão, null (o app usa o padrão).
- Vários itens numa frase = várias ações.
- Para remarcar/concluir/excluir, use o "ref" exato do item na lista abaixo. Se houver dúvida entre itens parecidos, não altere: pergunte no "reply" qual deles.
- Antes de criar, confira a lista: se já existir algo no mesmo horário, crie mesmo assim e avise no reply.
- Se faltar a data, pergunte (sem criar nada). Se faltar só a hora de um compromisso, crie sem hora e diga que dá para definir depois.
- Nunca invente itens que não estão na lista. Para "estou livre dia X?" ou "quais dias livres", analise a lista: dia livre = sem compromissos e sem itens com hora.
- reply: curto (1 a 3 frases), simpático, confirmando o que foi feito com dia da semana e data no formato "quinta, 13/11 às 14:00". Sem markdown.

AGENDA (ref | data | hora | min | tipo | título):
${(ctx.items || []).map(i => `${i.ref} | ${i.date || 'sem data'} | ${i.time || '-'} | ${i.min || '-'} | ${i.type}${i.done ? ' (feito)' : ''}${i.repeats ? ' (repete)' : ''} | ${i.title}`).join('\n') || '(vazia)'}`;
}

async function checkUser(req) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return { id: 'ip:' + (req.headers['x-forwarded-for'] || 'anon').split(',')[0] };
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(url.replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id } : null;
}

async function callOpenAI(messages, withEffort) {
  const body = {
    model: MODEL, messages,
    response_format: { type: 'json_schema', json_schema: { name: 'nova_agenda', strict: true, schema: SCHEMA } },
  };
  if (withEffort && /^gpt-5/.test(MODEL)) body.reasoning_effort = 'minimal';
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify(body),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'sem_chave' });

  let user;
  try { user = await checkUser(req); } catch (e) { user = null; }
  if (!user) return res.status(401).json({ error: 'login' });

  const now = Date.now(), h = (hits.get(user.id) || []).filter(t => now - t < 3600e3);
  if (h.length >= LIMIT_PER_HOUR) return res.status(429).json({ error: 'limite', reply: 'Muitos pedidos seguidos. Aguarde alguns minutos.' });
  h.push(now); hits.set(user.id, h);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const text = String((body && body.text) || '').slice(0, 1500).trim();
  const ctx = (body && body.context) || {};
  if (!text) return res.status(400).json({ error: 'vazio' });
  if (Array.isArray(ctx.items)) ctx.items = ctx.items.slice(0, 250);

  const history = Array.isArray(body.history) ? body.history.slice(-8)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) })) : [];
  const messages = [{ role: 'system', content: systemPrompt(ctx) }, ...history, { role: 'user', content: text }];

  try {
    let r = await callOpenAI(messages, true);
    if (r.status === 400) {               // modelo sem suporte a "reasoning_effort": tenta sem
      const t = await r.text();
      if (/reasoning_effort/i.test(t)) r = await callOpenAI(messages, false);
      else { console.error('OpenAI 400', t); return res.status(502).json({ error: 'openai' }); }
    }
    if (!r.ok) { console.error('OpenAI', r.status, await r.text()); return res.status(502).json({ error: 'openai' }); }
    const data = await r.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg || msg.refusal) return res.status(200).json({ reply: 'Não consegui entender esse pedido. Pode dizer de outro jeito?', actions: [] });
    const out = JSON.parse(msg.content);
    return res.status(200).json({ reply: out.reply || '', actions: Array.isArray(out.actions) ? out.actions : [] });
  } catch (e) {
    console.error('IA', e);
    return res.status(500).json({ error: 'falha' });
  }
};
