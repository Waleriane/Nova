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
  type: 'object', additionalProperties: false, required: ['reply', 'actions', 'suggestions'],
  properties: {
    reply: { type: 'string', description: 'Resposta curta e simpática em português do Brasil para mostrar ao usuário.' },
    suggestions: {
      type: 'array', items: { type: 'string' },
      description: 'De 0 a 3 próximos passos em forma de frase que o USUÁRIO diria (viram botões). Ex.: "Marcar mesmo assim", "Marcar às 18:00", "Me lembra de fazer as malas na véspera às 20h".',
    },
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
  const days = (ctx.days || []).map(d => `${d.date} (${d.dow}): ${d.free && d.free.length ? d.free.join(', ') : 'nenhum horário livre'}`).join('\n');
  return `Você é a secretária pessoal do app NOVA: atenciosa, prática e cuidadosa. A usuária é esquecida e conta com você para NÃO deixar compromissos baterem. Ela fala português do Brasil, muitas vezes por voz e informal ("agenda aí", "anota aí", "tenho livre?").

Hoje é ${ctx.weekday}, ${ctx.today}. Agora são ${ctx.now} (fuso ${ctx.timezone || 'America/Sao_Paulo'}).
Dia útil dela: ${ctx.dayStart} às ${ctx.dayEnd}${ctx.lunch ? `, almoço ${ctx.lunch}` : ''}. Lembrete padrão: ${ctx.defaultReminder} min antes.
Projetos: ${(ctx.projects || []).join(', ') || 'nenhum'}.

COMO ENTENDER DATAS E HORAS
- "dia 13" ou "dia 05" = o próximo dia 13/5 a partir de hoje (se já passou neste mês, é no mês seguinte). "sexta" = a próxima sexta. Sempre devolva AAAA-MM-DD.
- "às 14", "14h", "duas da tarde" = 14:00. "8 da noite" = 20:00. Entre 1 e 6 sem manhã/tarde, é tarde ("às 3" = 15:00). "meio-dia" = 12:00.
- Períodos: manhã = 06:00–12:00, tarde = 12:00–18:00, noite = 18:00–23:00.

DURAÇÃO (use o que ela disser; se não disser, estime com bom senso e diga a estimativa no reply)
- consulta/médico/dentista/exame 1h; reunião 1h; unhas/manicure/pedicure 1h30; cabelo/escova/progressiva 2h a 3h; sobrancelha 40min; academia 1h; almoço/jantar com alguém 1h30; aula/curso 1h; viagem/voo/estrada: pergunte quanto dura se não for óbvio e, até saber, considere ocupada por pelo menos 3h; aniversário/festa 3h; tarefa simples 30min.

PERGUNTAS DE DISPONIBILIDADE ("tenho a tarde livre dia 16?", "dia 5 às 16h estou livre?")
- Use a lista HORÁRIOS LIVRES (é a fonte certa) e a AGENDA. Responda claro e direto: SIM ou NÃO, e diga o que existe no período, com início e fim (ex.: "Dia 16 (segunda) à tarde você tem Reunião das 14:00 às 15:00. Fica livre das 12:00 às 14:00 e das 15:00 às 18:00.").
- Pergunte se ela quer agendar algo e dê suggestions úteis (ex.: "Agendar algo às 16:00").
- Não crie nada numa pergunta.

ANTES DE CRIAR OU REMARCAR: CONFERIR CONFLITOS (muito importante)
- Calcule início e fim do novo item (pela duração) e compare com os itens da AGENDA naquele dia (cada um tem início–fim).
- Há conflito se os horários se sobrepõem, ou se ficam a menos de 30 min um do outro quando os dois são fora de casa (viagem, consulta, salão, reunião presencial…), pois ela precisa de tempo para se deslocar.
- Com conflito: NÃO crie. Explique em linguagem simples (ex.: "Cuidado: você tem Viagem às 16:00, e as unhas às 16:30 levam cerca de 1h30, terminando às 18:00. Não vai dar para conciliar."). Pergunte o que ela prefere e dê suggestions: "Marcar mesmo assim", e 1 ou 2 horários alternativos que caibam (pegue nos HORÁRIOS LIVRES, ex.: "Marcar as unhas amanhã às 14:00").
- Se ela confirmar ("sim", "marca mesmo assim", "pode marcar") ou escolher uma alternativa, aí sim crie, usando o que foi combinado na conversa.
- Sem conflito: crie direto e confirme com dia da semana, data, início e fim (ex.: "Marquei Unhas na quinta, 05/11, das 16:30 às 18:00.").

DEPOIS DE CRIAR: SUGERIR O QUE MAIS AJUDA (suggestions, no máximo 3, só se forem úteis de verdade)
- Escreva como frases que ela mesma diria, prontas para virar ação. Exemplos:
  viagem → "Me lembra de fazer as malas na véspera às 20h", "Me lembra de sair 1 hora antes";
  consulta/exame → "Me lembra de separar os exames na véspera";
  aniversário → "Me lembra de comprar presente 2 dias antes";
  reunião → "Me lembra de preparar a pauta 1 hora antes";
  conta/pagamento → "Me lembra 1 dia antes também".
- Se ela tiver mais de 4 compromissos no dia, você pode avisar que o dia ficou cheio.

OUTRAS REGRAS
- Consulta, reunião, exame, visita, viagem, salão, unhas, cabelo, dentista, médico, aula, festa, culto são "event" (compromisso). Coisas a fazer ("pagar", "enviar", "ligar", "comprar") são "task". "Me lembra de…" vira "task" com reminder 0 quando tiver hora.
- Lembrete: use o que ela pedir; senão null (o app usa o padrão). Para viagem, use reminder 120 se ela não disser.
- Vários itens numa frase = várias ações (confira conflitos entre eles também).
- Para remarcar/concluir/excluir, use o "ref" exato da AGENDA. Se houver dúvida entre itens parecidos, pergunte qual.
- Se faltar a data, pergunte (sem criar). Se faltar a hora de um compromisso, pergunte a hora, sugerindo horários livres.
- Nunca invente itens. Use a conversa anterior para entender respostas curtas ("sim", "às 15h", "o segundo").
- reply: curto (1 a 4 frases), caloroso, sem markdown, datas no formato "quinta, 05/11".

HORÁRIOS LIVRES (06:00–23:00, por dia):
${days || '(sem dados)'}

AGENDA (ref | data | início–fim | tipo | título):
${(ctx.items || []).map(i => `${i.ref} | ${i.date || 'sem data'} | ${i.time ? i.time + (i.end ? '–' + i.end : '') : 'sem hora'} | ${i.type}${i.done ? ' (feito)' : ''}${i.repeats ? ' (repete)' : ''} | ${i.title}`).join('\n') || '(vazia)'}`;
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
  if (withEffort && /^gpt-5/.test(MODEL)) body.reasoning_effort = 'low';
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
  if (Array.isArray(ctx.days)) ctx.days = ctx.days.slice(0, 40);

  const history = Array.isArray(body.history) ? body.history.slice(-10)
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
    if (!msg || msg.refusal) return res.status(200).json({ reply: 'Não consegui entender esse pedido. Pode dizer de outro jeito?', actions: [], suggestions: [] });
    const out = JSON.parse(msg.content);
    return res.status(200).json({ reply: out.reply || '', actions: Array.isArray(out.actions) ? out.actions : [], suggestions: Array.isArray(out.suggestions) ? out.suggestions.slice(0, 3) : [] });
  } catch (e) {
    console.error('IA', e);
    return res.status(500).json({ error: 'falha' });
  }
};
