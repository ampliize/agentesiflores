// Painel da Equipe dos Sonhos (JS puro, sem build). Fala com a API em /api/v1.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: d })}%`);
const sig = (v) => `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '▲' : '▼'} ${pct(Math.abs(v))}</span>`;
const ago = (iso) => { if (!iso) return ''; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'agora'; if (s < 3600) return `${Math.floor(s / 60)} min`; if (s < 86400) return `${Math.floor(s / 3600)} h`; return new Date(iso).toLocaleDateString('pt-BR'); };
const dt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const dia = (s) => (s ? s.split('-').reverse().slice(0, 2).join('/') : '—');

const AG = { alex: { nome: 'Alex', area: 'Gestão' }, flora: { nome: 'Flora', area: 'Atendimento' }, mari: { nome: 'Mari', area: 'Conteúdo' }, caio: { nome: 'Caio', area: 'Anúncios' }, sol: { nome: 'Sol', area: 'Finanças' } };
const cor = (k) => `var(--c-${k})`;
const av = (k) => `<span class="av" style="--c:${cor(k)}">${AG[k]?.nome[0] || '?'}</span>`;
let TOKEN = window.__EQ_TOKEN || (() => { try { return new URLSearchParams(location.search).get('token') || sessionStorage.getItem('eq_token'); } catch { return null; } })();
let ME = null; let FEED = [];

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, { method: opts.method || 'GET', headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
const post = (p, body = {}) => api(p, { method: 'POST', body });
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800); }
async function busy(btn, fn) { const tx = btn?.innerHTML; if (btn) { btn.disabled = true; btn.textContent = 'Trabalhando…'; } try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn) { btn.disabled = false; btn.innerHTML = tx; } } }
function modal(html, onClose) { const d = $('#modal'); $('#modalBody').innerHTML = html; d.returnValue = ''; d.onclose = () => onClose?.(d.returnValue, $('#modalBody')); d.showModal(); }

// ------------------------------------------------------------------ boot
async function boot() {
  if (!TOKEN) { $('#login').hidden = false; return; }
  try { ME = await api('/me'); } catch { TOKEN = null; $('#login').hidden = false; return; }
  try { sessionStorage.setItem('eq_token', TOKEN); } catch { /* sem storage */ }
  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
  $('#app').hidden = false; $('#login').hidden = true;
  $('#storeName').textContent = ME.tenant.name;
  const m = $('#modePill'); m.textContent = ME.ai.enabled ? `IA ativa · ${ME.ai.model}` : ME.tenant.demo ? 'Demonstração' : 'Sem IA configurada'; m.classList.toggle('on', ME.ai.enabled);
  tempoReal(); window.addEventListener('hashchange', route); route();
}
$('#btnDemo').onclick = async () => { const r = await fetch('/api/v1/demo', { method: 'POST' }).then((x) => x.json()); TOKEN = r.token; boot(); };

function tempoReal() {
  const es = new EventSource(`/api/v1/tempo-real?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === 'activity') { FEED.unshift(ev.item); FEED = FEED.slice(0, 100); const f = $('#feed'); if (f) f.insertAdjacentHTML('afterbegin', feedItem(ev.item)); refreshSoon(); }
    if (ev.kind === 'status') { const c = $(`.agent[data-k="${ev.agent}"]`); if (c) { const st = $('.stx', c); st.className = `chip stx ${ev.status === 'trabalhando' ? 'info live' : 'ok'}`; st.innerHTML = `<span class="dot"></span>${ev.status === 'trabalhando' ? 'Trabalhando' : 'Online'}`; if (ev.current) $('.now', c).textContent = ev.current; } }
  };
}
let _r; function refreshSoon() { clearTimeout(_r); _r = setTimeout(() => { badges(); if (tab() === 'equipe') equipe(true); }, 1200); }
const tab = () => location.hash.slice(1).split('/')[0] || 'equipe';
const VIEWS = {};
function route() { const t = tab(); $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === t)); (VIEWS[t] || VIEWS.equipe)(); badges(); }
async function badges() { try { const [t, p] = await Promise.all([api('/tarefas?status=aguardando_dono'), api('/conteudo/posts?status=aguardando_aprovacao')]); $('#bTarefas').textContent = t.length || ''; $('#bConteudo').textContent = p.length || ''; } catch { /* ignora */ } }
const view = (html) => { $('#view').innerHTML = html; return $('#view'); };

// ------------------------------------------------------------------ EQUIPE
const KIND = { acao: '<span class="chip ok">Executou</span>', sugestao: '<span class="chip warn">Sugeriu</span>', info: '' };
function feedItem(a) { return `<div class="feed-item ${esc(a.level)}"><span class="ic" style="--c:${cor(a.agent)}">${AG[a.agent]?.nome[0] || '•'}</span><div><div class="m">${esc(a.message)}</div><div class="meta">${KIND[a.kind] || ''}<span>${esc(AG[a.agent]?.nome || a.agent)} · ${ago(a.created_at)}</span></div></div></div>`; }
function agentCard(a) {
  const st = a.status === 'nao_contratado' ? '<span class="chip">Não contratado</span>' : a.status === 'pausado' ? '<span class="chip warn">Pausado</span>' : a.status === 'trabalhando' ? '<span class="chip stx info live"><span class="dot"></span>Trabalhando</span>' : '<span class="chip stx ok"><span class="dot"></span>Online</span>';
  const area = { alex: 'loja', flora: 'atendimento', mari: 'conteudo', caio: 'anuncios', sol: 'financas' }[a.key];
  return `<article class="card agent ${a.contratado ? '' : 'off'}" data-k="${a.key}" style="--c:${cor(a.key)}">
    <div class="row">${av(a.key)}<div class="grow"><div class="nm">${esc(a.nome)} <span class="ar">· ${esc(a.area)}</span></div><div>${st}</div></div></div>
    <div class="now">${esc(a.contratado ? a.agora : a.resumo)}</div>
    ${a.contratado ? `<div class="st"><div><b>${a.acoes_24h}</b><span>executou 24h</span></div><div><b>${a.sugestoes_24h}</b><span>sugeriu 24h</span></div><div><b>${a.pendentes}</b><span>pendências</span></div></div>
    <div class="acts">${['alex', 'sol', 'mari', 'caio'].includes(a.key) ? `<a class="btn sm primary" href="#conversar/${a.key}">Conversar</a>` : `<a class="btn sm primary" href="#atendimento">Ver conversas</a>`}<a class="btn sm" href="#${area}">Abrir</a>${a.key !== 'sol' ? `<button class="btn sm" data-run="${a.key}" type="button">Executar agora</button>` : ''}</div>`
    : `<div class="acts"><button class="btn sm primary" data-hire="${a.key}" type="button">Contratar</button></div>`}
  </article>`;
}
VIEWS.equipe = equipe;
async function equipe(soft = false) {
  const [d, atv, dec] = await Promise.all([api('/equipe'), soft && FEED.length ? Promise.resolve(FEED) : api('/atividade?limit=60'), api('/tarefas?status=aguardando_dono')]);
  if (tab() !== 'equipe') return; FEED = atv;
  const s = d.semana; const alex = d.equipe.find((a) => a.key === 'alex');
  const v = view(`
    <div class="sec-head"><div class="grow"><h2>Sua equipe</h2><p>Últimos 7 dias comparados com os 7 anteriores.</p></div><button class="btn" id="rot" type="button">Rodar todas as rotinas agora</button></div>
    <div class="kpis">
      <div class="card kpi"><div class="l">Faturamento</div><div class="v">${brl(s.faturamento)}</div><div class="d">${sig(s.variacoes.faturamento)}</div></div>
      <div class="card kpi"><div class="l">Pedidos</div><div class="v">${s.pedidos}</div><div class="d">${sig(s.variacoes.pedidos)}</div></div>
      <div class="card kpi"><div class="l">Ticket médio</div><div class="v">${brl(s.ticket)}</div><div class="d">${sig(s.variacoes.ticket)}</div></div>
      <div class="card kpi"><div class="l">Conversão da loja</div><div class="v">${pct(s.conversao)}</div><div class="d">${sig(s.variacoes.conversao)}</div></div>
      <div class="card kpi"><div class="l">Esperando sua decisão</div><div class="v">${d.pendencias}</div><div class="d"><a href="#tarefas">ver tarefas</a></div></div>
    </div>
    <div class="team">
      <div><div class="org-top">${agentCard(alex)}</div><div class="org-link"></div><div class="org-row" style="margin-top:14px">${['flora', 'mari', 'caio', 'sol'].map((k) => agentCard(d.equipe.find((a) => a.key === k))).join('')}</div>
        <div class="card" style="margin-top:16px"><div class="row" style="margin-bottom:8px"><h3 class="grow" style="margin:0">Para você decidir</h3><a href="#tarefas" class="small">todas</a></div>
          <div class="decide">${dec.slice(0, 5).map((t) => `<div class="it" style="--c:${cor(t.responsavel)}"><div class="row">${av(t.responsavel)}<div class="grow"><b>${esc(t.titulo)}</b><div class="small muted">${t.tipo === 'recomendacao' ? 'Recomendação' : 'Sugestão'} de ${esc(AG[t.responsavel]?.nome)}${t.acao?.label ? ` · ${esc(t.acao.label)}` : ''}</div></div></div><div class="row"><button class="btn sm primary" data-ok="${t.id}" type="button">${t.acao ? 'Aprovar e executar' : 'Marcar como feito'}</button><button class="btn sm" data-no="${t.id}" type="button">Recusar</button></div></div>`).join('') || '<div class="empty">Nada esperando por você.</div>'}</div></div>
      </div>
      <div class="card"><div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">O que a equipe está fazendo</h3><span class="chip ok live"><span class="dot"></span>ao vivo</span></div><div class="feed" id="feed">${FEED.map(feedItem).join('') || '<div class="empty">Sem atividade ainda.</div>'}</div></div>
    </div>`);
  $$('[data-run]', v).forEach((b) => (b.onclick = () => busy(b, async () => { await post(`/agentes/${b.dataset.run}/executar`); toast('Pronto!'); equipe(true); })));
  $$('[data-hire]', v).forEach((b) => (b.onclick = () => busy(b, async () => { await post(`/agentes/${b.dataset.hire}/contratar`, { contratado: true }); toast('Agente contratado'); equipe(); })));
  $$('[data-ok]', v).forEach((b) => (b.onclick = () => busy(b, async () => { const r = await post(`/tarefas/${b.dataset.ok}/aprovar`); toast(r.texto || 'Feito'); equipe(); badges(); })));
  $$('[data-no]', v).forEach((b) => (b.onclick = async () => { await post(`/tarefas/${b.dataset.no}/recusar`); equipe(); badges(); }));
  $('#rot').onclick = (e) => busy(e.currentTarget, async () => { const r = await post('/rotinas'); toast(`Rotinas: ${r.feitos.join(', ') || 'nada pendente'}`); equipe(); });
}

// ------------------------------------------------------------------ CONVERSAR
const EXEMPLOS = {
  alex: ['Acabou a rosa vermelha. Desative os produtos que usam essa flor.', 'No dia 7 não teremos entregas, mas podemos receber pedidos para os outros dias.', 'Ative o catálogo de data comemorativa do dia 10 ao dia 12.', 'Atualize o estoque deste produto para 15 unidades.', 'Configure o frete desse bairro para R$12.', 'O que devo fazer esta semana?', 'Sugestão de compras', 'Desfaça a última alteração'],
  sol: ['Meu buquê custa R$50 para produzir. Por quanto posso vender?', 'Posso dar 10% de desconto no Buquê Primavera?', 'Por que estou vendendo mais e sobrando menos?', 'Qual a margem da Cesta Café da Manhã?', 'Quais produtos têm margem baixa?'],
  mari: ['Crie posts sobre as orquídeas para o fim de semana', 'Quero mais stories mostrando a loja aberta'],
  caio: ['Quero uma campanha para o Natal', 'Foque os anúncios em Moema e Vila Mariana'],
};
VIEWS.conversar = async () => {
  const k = location.hash.split('/')[1] || 'alex';
  const msgs = await api(`/agentes/${k}/chat`);
  const v = view(`<div class="chat-wrap"><div class="who">${['alex', 'sol', 'mari', 'caio'].map((x) => `<button type="button" class="${x === k ? 'on' : ''}" style="--c:${cor(x)}" data-w="${x}">${av(x)}<span><b>${AG[x].nome}</b><br><span class="small muted">${AG[x].area}</span></span></button>`).join('')}<p class="small muted">A Flora conversa com os clientes. Teste em <a href="#atendimento">Atendimento</a>.</p></div>
    <section class="card chat" style="--c:${cor(k)}"><div class="hd">${av(k)}<div class="grow"><b>${AG[k].nome}</b><div class="small muted">${k === 'alex' ? 'Executa alterações na loja (com histórico e desfazer) e orienta com os dados.' : k === 'sol' ? 'Responde sobre custos, preços, margem e descontos, sempre com as premissas.' : 'Recebe pedidos e transforma em tarefas.'}</div></div></div>
      <div class="msgs" id="msgs">${msgs.map(bubble).join('') || `<div class="empty">Comece com um dos exemplos abaixo.</div>`}</div>
      <div class="chips">${(EXEMPLOS[k] || []).map((e) => `<button class="btn sm" type="button" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>
      <form id="say"><input id="sayInput" name="t" autocomplete="off" placeholder="Escreva para ${AG[k].nome}…" required><button class="btn primary">Enviar</button></form></section></div>`);
  const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  $$('[data-w]', v).forEach((b) => (b.onclick = () => { location.hash = `conversar/${b.dataset.w}`; }));
  $$('[data-ex]', v).forEach((b) => (b.onclick = () => { $('#sayInput').value = b.dataset.ex; $('#say').requestSubmit(); }));
  bindUndo(v);
  $('#say').onsubmit = async (e) => {
    e.preventDefault(); const t = $('#sayInput').value.trim(); if (!t) return; $('#sayInput').value = '';
    $('.empty', box)?.remove();
    box.insertAdjacentHTML('beforeend', `${bubble({ role: 'user', texto: t })}<div class="bub ag" id="typing">${AG[k].nome} está escrevendo…</div>`); box.scrollTop = box.scrollHeight;
    try { const r = await post(`/agentes/${k}/conversar`, { texto: t }); $('#typing').outerHTML = bubble({ role: 'assistant', texto: r.texto, change_id: r.change_id }); bindUndo(box); } catch (err) { $('#typing').textContent = err.message; }
    box.scrollTop = box.scrollHeight;
  };
};
function bubble(m) { return `<div class="bub ${m.role === 'user' ? 'me' : 'ag'}">${esc(m.texto)}${m.change_id ? `<div style="margin-top:6px"><button class="btn sm" type="button" data-undo="${m.change_id}">Desfazer esta alteração</button></div>` : ''}</div>`; }
function bindUndo(el) { $$('[data-undo]', el).forEach((b) => (b.onclick = () => busy(b, async () => { await post(`/loja/alteracoes/${b.dataset.undo}/desfazer`); toast('Alteração desfeita'); b.replaceWith(Object.assign(document.createElement('span'), { className: 'chip', textContent: 'desfeita' })); }))); }

// ------------------------------------------------------------------ TAREFAS
const TIPO = { sugestao: '<span class="chip warn">Sugestão</span>', recomendacao: '<span class="chip acc">Recomendação</span>', pedido: '<span class="chip info">Pedido</span>', acao: '<span class="chip ok">Ação executada</span>' };
VIEWS.tarefas = async () => {
  const ts = await api('/tarefas');
  const cols = [['aguardando_dono', 'Esperando você'], ['aberta', 'Em aberto'], ['concluida', 'Concluídas'], ['recusada', 'Recusadas']];
  const card = (t) => { const r = t.recomendacao; return `<div class="task" style="--c:${cor(t.responsavel)}"><div class="row">${TIPO[t.tipo] || ''}<span class="chip">${esc(AG[t.responsavel]?.nome)}</span>${t.prioridade === 'alta' ? '<span class="chip bad">alta</span>' : ''}</div><b>${esc(t.titulo)}</b>
    ${r ? `<dl><dt>O que aconteceu</dt><dd>${esc(r.aconteceu)}</dd><dt>Hipótese</dt><dd>${esc(r.hipotese)}</dd><dt>O que fazer agora</dt><dd>${esc(r.fazer_agora)}</dd><dt>O Alex pode executar</dt><dd>${esc(r.alex_executa?.label || 'Nada automático')}</dd><dt>Revisar em</dt><dd>${dia(r.revisar_em)}</dd></dl>` : t.detalhes ? `<div class="small muted">${esc(t.detalhes)}</div>` : ''}
    ${t.resultado ? `<div class="small"><b>Resultado:</b> ${esc(t.resultado)}</div>` : ''}${t.revisao ? `<div class="small"><b>Revisão:</b> ${esc(t.revisao.texto)}</div>` : ''}
    <div class="small muted">Pedido por ${esc(t.solicitante === 'dono' ? 'você' : AG[t.solicitante]?.nome || t.solicitante)} · ${ago(t.created_at)}</div>
    ${t.status === 'aguardando_dono' ? `<div class="row"><button class="btn sm primary" type="button" data-ok="${t.id}">${t.acao ? 'Aprovar e executar' : 'Marcar como feito'}</button><button class="btn sm" type="button" data-no="${t.id}">Recusar</button></div>` : ''}
    ${t.status === 'aberta' ? `<div class="row"><button class="btn sm" type="button" data-done="${t.id}">Concluir</button></div>` : ''}</div>`; };
  const v = view(`<div class="sec-head"><div class="grow"><h2>Tarefas</h2><p>Tudo o que a equipe sugeriu, pediu ou executou, com responsável, status e resultado.</p></div></div>
    <form class="card row" id="nova" style="margin-bottom:14px"><select name="responsavel" style="width:auto">${Object.keys(AG).map((k) => `<option value="${k}">${AG[k].nome} (${AG[k].area})</option>`).join('')}</select><input name="titulo" class="grow" placeholder="Ex.: Mari, crie um post sobre a orquídea branca" required style="width:auto"><button class="btn primary">Pedir</button></form>
    <div class="kanban">${cols.map(([k, l]) => { const xs = ts.filter((t) => (k === 'aberta' ? ['aberta', 'em_andamento'].includes(t.status) : t.status === k)); return `<div class="col"><h4>${l}<span>${xs.length}</span></h4>${xs.slice(0, 40).map(card).join('') || '<div class="empty">—</div>'}</div>`; }).join('')}</div>`);
  $('#nova').onsubmit = async (e) => { e.preventDefault(); await post('/tarefas', Object.fromEntries(new FormData(e.target))); toast('Pedido registrado'); VIEWS.tarefas(); };
  $$('[data-ok]', v).forEach((b) => (b.onclick = () => busy(b, async () => { const r = await post(`/tarefas/${b.dataset.ok}/aprovar`); toast(r.texto || 'Feito'); VIEWS.tarefas(); badges(); })));
  $$('[data-no]', v).forEach((b) => (b.onclick = async () => { await post(`/tarefas/${b.dataset.no}/recusar`); VIEWS.tarefas(); badges(); }));
  $$('[data-done]', v).forEach((b) => (b.onclick = async () => { await api(`/tarefas/${b.dataset.done}`, { method: 'PATCH', body: { status: 'concluida', resultado: 'Concluída pelo dono' } }); VIEWS.tarefas(); }));
};

// ------------------------------------------------------------------ ATENDIMENTO (Flora)
let conv = null;
const CANAL = { whatsapp: 'WhatsApp', chat_loja: 'Chat da loja', simulador: 'Simulador' };
VIEWS.atendimento = async () => {
  const [cs, peds] = await Promise.all([api('/atendimento/conversas'), api('/pedidos')]);
  if (conv === null && cs[0]) conv = cs[0].id;
  const v = view(`<div class="sec-head"><div class="grow"><h2>Atendimento da Flora</h2><p>WhatsApp e chat da loja. Quando alguém da equipe responde, a Flora pausa naquela conversa.</p></div><button class="btn primary" id="novoCli" type="button">Simular um cliente</button></div>
    <div class="grid2" style="grid-template-columns:minmax(0,300px) minmax(0,1fr)"><div class="card" style="padding:6px;max-height:72vh;overflow:auto">${cs.map((c) => `<button type="button" class="btn ghost" data-c="${esc(c.id)}" style="display:grid;justify-items:start;width:100%;text-align:left;${c.id === conv ? 'background:var(--surface-2)' : ''}"><span class="row" style="width:100%"><b class="grow">${esc(c.nome || c.contato)}</b><span class="chip ${c.status === 'humano' ? 'warn' : 'ok'}">${c.status === 'humano' ? 'Pessoa' : 'Flora'}</span></span><span class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(c.ultima?.texto || '')}</span><span class="small muted">${CANAL[c.canal]} · ${ago(c.updated_at)}</span></button>`).join('') || '<div class="empty">Nenhuma conversa ainda.</div>'}</div>
    <section class="card chat" id="pane" style="--c:var(--c-flora)"></section></div>
    <div class="card" style="margin-top:16px"><h3>Pedidos recentes</h3><div class="tw"><table><thead><tr><th>Nº</th><th>Cliente</th><th>Itens</th><th>Entrega</th><th class="num">Total</th><th>Pedido</th><th>Pagamento</th><th>Origem</th><th></th></tr></thead><tbody>${peds.slice(0, 15).map((o) => `<tr><td>#${o.numero}</td><td>${esc(o.comprador)}</td><td>${esc(o.itens.map((i) => i.nome).join(', '))}</td><td>${dia(o.data)} ${esc(o.modalidade === 'retirada' ? 'retirada' : o.bairro || '')}</td><td class="num">${brl(o.total)}</td><td>${esc(o.status.replace(/_/g, ' '))}</td><td><span class="chip ${o.pagamento.status === 'confirmado' ? 'ok' : 'warn'}">${o.pagamento.status === 'confirmado' ? 'confirmado pelo sistema' : 'aguardando'}</span></td><td>${esc(o.origem)}</td><td>${ME.tenant.demo && o.pagamento.status !== 'confirmado' ? `<button class="btn sm" type="button" data-pay="${o.id}">Simular pagamento</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">Na loja real, o pagamento só aparece como confirmado quando o sistema de pagamento avisa. Enviar o link não confirma nada.</p></div>`);
  $$('[data-c]', v).forEach((b) => (b.onclick = () => { conv = b.dataset.c; VIEWS.atendimento(); }));
  $$('[data-pay]', v).forEach((b) => (b.onclick = () => busy(b, async () => { await post(`/pedidos/${b.dataset.pay}/simular-pagamento`); toast('Pagamento confirmado (simulação)'); VIEWS.atendimento(); })));
  $('#novoCli').onclick = () => { conv = 'novo'; pane(); };
  pane();
};
async function pane() {
  const p = $('#pane'); if (!p) return;
  let c = null; let ms = [];
  if (conv && conv !== 'novo') ({ conversa: c, mensagens: ms } = await api(`/atendimento/conversas/${encodeURIComponent(conv)}`));
  const sim = !c || c.canal === 'simulador';
  const who = { cliente: 'cli', flora: 'flo', funcionario: 'fun' };
  p.innerHTML = `<div class="hd">${av('flora')}<div class="grow"><b>${esc(c?.nome || c?.contato || 'Novo cliente (simulador)')}</b><div class="small muted">${CANAL[c?.canal || 'simulador']}${c?.status === 'humano' ? ` · com uma pessoa da loja${c.motivo_transferencia ? ` (${esc(c.motivo_transferencia)})` : ''}` : ''}</div></div>${c?.status === 'humano' ? '<button class="btn sm" type="button" id="devolver">Devolver para a Flora</button>' : ''}</div>
    <div class="msgs" id="cm">${ms.map((m) => `<div class="bub ${who[m.role]}"><span class="by">${m.role === 'cliente' ? 'Cliente' : m.role === 'flora' ? 'Flora' : 'Equipe da loja'}</span>${esc(m.texto)}</div>`).join('') || '<div class="empty">Escreva como se fosse um cliente. Ex.: "Quero flores para o aniversário da minha mãe, até R$200"</div>'}</div>
    ${sim ? '<form id="cliF"><input id="cliT" autocomplete="off" placeholder="Mensagem do cliente…" required><button class="btn primary">Enviar como cliente</button></form>' : ''}
    ${c ? `<form id="funF"><input id="funT" autocomplete="off" placeholder="Responder como alguém da loja (a Flora pausa)…" required><button class="btn">Responder</button></form>` : ''}`;
  const box = $('#cm'); box.scrollTop = box.scrollHeight;
  $('#devolver') && ($('#devolver').onclick = async () => { await post(`/atendimento/conversas/${encodeURIComponent(c.id)}/devolver`); toast('A Flora voltou a atender'); VIEWS.atendimento(); });
  $('#funF') && ($('#funF').onsubmit = async (e) => { e.preventDefault(); await post(`/atendimento/conversas/${encodeURIComponent(c.id)}/assumir`, { texto: $('#funT').value }); VIEWS.atendimento(); });
  $('#cliF') && ($('#cliF').onsubmit = async (e) => {
    e.preventDefault(); const t = $('#cliT').value; $('#cliT').value = ''; $('.empty', box)?.remove();
    box.insertAdjacentHTML('beforeend', `<div class="bub cli"><span class="by">Cliente</span>${esc(t)}</div><div class="bub flo" id="typing">Flora está escrevendo…</div>`); box.scrollTop = box.scrollHeight;
    const r = await post('/atendimento/mensagem', { canal: 'simulador', contato: c?.contato || `sim_${Date.now()}`, texto: t });
    conv = r.conversa_id; VIEWS.atendimento();
  });
}

// ------------------------------------------------------------------ CONTEÚDO (Mari)
const PST = { aguardando_aprovacao: 'Para aprovar', agendado: 'Agendadas', publicado: 'Publicadas', pausado_indisponivel: 'Pausadas (produto indisponível)', aprovado: 'Anúncios aprovados', descartado: 'Descartadas' };
const FMT = { feed: 'Post', carrossel: 'Carrossel', story_sequencia: 'Stories', anuncio: 'Anúncio' };
let pf = 'aguardando_aprovacao';
VIEWS.conteudo = async () => {
  const [ps, fotos, prods] = await Promise.all([api('/conteudo/posts'), api('/conteudo/fotos'), api('/loja/produtos')]);
  const n = (k) => ps.filter((p) => p.status === k).length;
  const lista = ps.filter((p) => pf === 'todas' || p.status === pf);
  const v = view(`<div class="sec-head"><div class="grow"><h2>Conteúdo da Mari</h2><p>As fotos entram inteiras, sem retoque: o texto fica numa faixa separada para não mudar o que a loja entrega.</p></div><button class="btn primary" id="plan" type="button">Planejar a próxima semana</button></div>
    <div class="filters">${Object.entries(PST).map(([k, l]) => `<button type="button" class="btn sm ${pf === k ? 'on' : ''}" data-f="${k}">${l} (${n(k)})</button>`).join('')}<button type="button" class="btn sm ${pf === 'todas' ? 'on' : ''}" data-f="todas">Todas</button>
      ${pf === 'aguardando_aprovacao' && lista.length ? '<span class="grow"></span><button class="btn sm primary" type="button" id="lote">Aprovar selecionadas</button><button class="btn sm" type="button" id="todas">Selecionar todas</button>' : ''}</div>
    <div class="posts">${lista.map(postCard).join('') || '<div class="card empty">Nada aqui.</div>'}</div>
    <div class="card" style="margin-top:18px"><div class="sec-head"><div class="grow"><h3 style="margin:0">Biblioteca de fotos</h3><p class="small">${fotos.length} fotos. A Mari evita repetir a mesma foto e pede fotos novas quando precisa.</p></div>
      <form id="up" class="row"><select name="produto_id" style="width:auto"><option value="">Foto geral da loja</option>${prods.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select><input type="file" name="f" accept="image/*" required style="width:auto"><button class="btn">Enviar foto</button></form></div>
      <div class="lib">${fotos.map((f) => `<figure><img src="${esc(f.url)}" alt="${esc(f.legenda)}" loading="lazy"><figcaption>${esc(f.legenda || 'sem legenda')}<br>${f.usos ? `usada ${f.usos}x` : 'ainda não usada'}${f.demo ? ' · ilustração' : ''}</figcaption></figure>`).join('')}</div></div>`);
  $$('[data-f]', v).forEach((b) => (b.onclick = () => { pf = b.dataset.f; VIEWS.conteudo(); }));
  $('#plan').onclick = (e) => busy(e.currentTarget, async () => { const r = await post('/agentes/mari/executar'); toast(`${r.pecas} peças criadas`); pf = 'aguardando_aprovacao'; VIEWS.conteudo(); });
  $('#lote') && ($('#lote').onclick = (e) => busy(e.currentTarget, async () => { const ids = $$('.sel:checked').map((i) => i.value); if (!ids.length) return toast('Selecione as peças'); await post('/conteudo/aprovar', { ids }); toast(`${ids.length} peça(s) aprovadas`); VIEWS.conteudo(); badges(); }));
  $('#todas') && ($('#todas').onclick = () => $$('.sel').forEach((i) => { i.checked = true; }));
  $$('[data-ap]', v).forEach((b) => (b.onclick = () => busy(b, async () => { await post('/conteudo/aprovar', { ids: [b.dataset.ap] }); toast('Aprovada'); VIEWS.conteudo(); badges(); })));
  $$('[data-pub]', v).forEach((b) => (b.onclick = () => busy(b, async () => { const r = await post(`/conteudo/posts/${b.dataset.pub}/publicar-agora`); toast(r.status === 'publicado' ? 'Publicada' : `Não publicada: ${r.motivo || r.status}`); VIEWS.conteudo(); })));
  $$('[data-des]', v).forEach((b) => (b.onclick = async () => { await post(`/conteudo/posts/${b.dataset.des}/descartar`); VIEWS.conteudo(); badges(); }));
  $$('[data-adj]', v).forEach((b) => (b.onclick = () => modal(`<h3>Pedir ajuste à Mari</h3><label class="f">O que mudar?<textarea name="p" placeholder='Ex.: "título: Flores que abraçam" ou "legenda: ..."'></textarea><small>Comece com "título:" ou "legenda:" para trocar o texto.</small></label><div class="row"><span class="grow"></span><button class="btn" value="x">Cancelar</button><button class="btn primary" value="ok">Ajustar</button></div>`,
    async (val, f) => { if (val !== 'ok') return; await post(`/conteudo/posts/${b.dataset.adj}/ajustar`, { pedido: f.p.value }); toast('Peça ajustada'); VIEWS.conteudo(); })));
  $$('.strip img', v).forEach((im) => (im.onclick = () => { im.closest('.post').querySelector('.img img').src = im.src; }));
  $('#up').onsubmit = (e) => { e.preventDefault(); const f = e.target.f.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = async () => { await post('/conteudo/fotos', { url: rd.result, produto_id: e.target.produto_id.value || null, legenda: f.name.replace(/\.\w+$/, '') }); toast('Foto adicionada'); VIEWS.conteudo(); }; rd.readAsDataURL(f); };
};
function postCard(p) {
  return `<article class="card post"><div class="img"><img src="${esc(p.slides[0]?.imagem)}" alt="${esc(p.slides[0]?.titulo)}" loading="lazy">${p.status === 'aguardando_aprovacao' ? `<input type="checkbox" class="sel" value="${p.id}" aria-label="Selecionar">` : ''}</div>
    <div>${p.slides.length > 1 ? `<div class="strip">${p.slides.map((s) => `<img src="${esc(s.imagem)}" alt="">`).join('')}</div>` : ''}
    <div class="body"><div class="row"><span class="chip">${FMT[p.formato]}${p.slides.length > 1 ? ` · ${p.slides.length}` : ''}</span><span class="chip ${p.status === 'publicado' ? 'ok' : p.status === 'pausado_indisponivel' ? 'bad' : 'warn'}">${esc(PST[p.status] || p.status)}</span>${p.criado_por === 'caio' ? '<span class="chip info">feito pelo Caio</span>' : ''}</div>
      <b>${esc(p.slides[0]?.titulo)}</b><span class="small muted">${p.formato === 'anuncio' ? 'Criativo para anúncio' : `📅 ${dt(p.scheduled_at)}`}${p.motivo ? ` · ${esc(p.motivo)}` : ''}</span><div class="cap">${esc(p.legenda)}</div></div></div>
    <div class="acts">${['aguardando_aprovacao', 'pausado_indisponivel'].includes(p.status) ? `<button class="btn sm primary" type="button" data-ap="${p.id}">Aprovar</button>` : ''}${p.status === 'agendado' ? `<button class="btn sm" type="button" data-pub="${p.id}">Publicar agora</button>` : ''}${!['publicado', 'descartado'].includes(p.status) ? `<button class="btn sm" type="button" data-adj="${p.id}">Ajustar</button><button class="btn sm ghost" type="button" data-des="${p.id}">Descartar</button>` : ''}</div></article>`;
}

// ------------------------------------------------------------------ ANÚNCIOS (Caio)
VIEWS.anuncios = async () => {
  const d = await api('/anuncios');
  const ativo = d.campanhas.filter((c) => c.status === 'ativa').reduce((s, c) => s + c.orcamento_diario, 0);
  const a = d.ultima_analise;
  const v = view(`<div class="sec-head"><div class="grow"><h2>Anúncios do Caio</h2><p>Meta (Facebook e Instagram) e Google. A verba de mídia é separada do valor do agente.</p></div><button class="btn primary" id="an" type="button">Analisar agora</button></div>
    <div class="grid2"><div class="card"><h4>Teto de gasto definido por você</h4><div class="row"><b class="grow">${brl(ativo)} por dia em campanhas ativas</b><span>teto ${brl(d.config.teto_diario)}/dia · ${brl(d.config.teto_mensal)}/mês</span></div><div class="meter" style="margin:8px 0"><i style="width:${Math.min(100, (ativo / d.config.teto_diario) * 100)}%"></i></div><p class="small muted">O Caio só aumenta o teto com a sua autorização. Autonomia atual: ${d.config.autonomia === 'sugerir' ? 'só sugere' : 'ajusta e pausa dentro do teto'}.</p></div>
      <div class="card"><h4>Verba inicial de teste sugerida</h4><b>${brl(d.verba_teste.diaria)}/dia por ${d.verba_teste.semanas} semanas (${brl(d.verba_teste.total)})</b><p class="small muted">${esc(d.verba_teste.raciocinio)}</p><p class="small muted">Criativos: ${d.mari_contratada ? 'aproveita as peças da Mari' : 'ferramenta própria do Caio (Mari não contratada)'}.</p></div></div>
    <div class="card tw" style="margin-top:16px"><table><thead><tr><th>Campanha</th><th>Canal</th><th>Status</th><th>Produtos</th><th class="num">Orç./dia</th><th class="num">Gasto 7d</th><th class="num">CTR</th><th class="num">Compras</th><th class="num">ROAS</th><th></th></tr></thead>
      <tbody>${d.campanhas.map((c) => `<tr><td>${esc(c.nome)}${c.criada_por === 'caio' ? ' <span class="chip info">nova</span>' : ''}</td><td>${c.plataforma === 'meta' ? 'Meta' : 'Google'}</td><td><span class="chip ${c.status === 'ativa' ? 'ok' : ''}">${c.status}</span>${c.pausada_por ? `<div class="small muted">${esc(c.pausada_por)}</div>` : ''}</td><td class="small">${esc(c.produtos.filter(Boolean).join(', '))}</td><td class="num">${brl(c.orcamento_diario)}</td><td class="num">${brl(c.metricas.gasto)}</td><td class="num">${(c.metricas.ctr || 0).toLocaleString('pt-BR')}%</td><td class="num">${c.metricas.compras}</td><td class="num"><b>${(c.metricas.roas || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</b></td><td>${c.status === 'ativa' ? `<button class="btn sm" type="button" data-pause="${c.id}">Pausar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${a ? `<div class="card" style="margin-top:16px"><h3>Última análise <span class="small muted">${ago(a.created_at)}</span></h3><p>Gasto de ${brl(a.gasto_7d)} em 7 dias e ${brl(a.receita_7d)} em compras identificáveis (ROAS ${(a.roas || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}). Ocupação da produção: ${pct(a.ocupacao, 0)}.</p><ul>${a.decisoes.map((x) => `<li><b>${esc(x.campanha)}</b>: ${esc(x.motivo)}</li>`).join('') || '<li class="muted">Nenhum ajuste necessário.</li>'}</ul><p class="small muted">Sugestões que dependem de você (novas campanhas, aumento de teto) ficam em <a href="#tarefas">Tarefas</a>.</p></div>` : ''}`);
  $('#an').onclick = (e) => busy(e.currentTarget, async () => { await post('/agentes/caio/executar'); toast('Análise concluída'); VIEWS.anuncios(); });
  $$('[data-pause]', v).forEach((b) => (b.onclick = () => busy(b, async () => { await post(`/anuncios/${b.dataset.pause}/pausar`); VIEWS.anuncios(); })));
};

// ------------------------------------------------------------------ FINANÇAS (Sol)
VIEWS.financas = async () => {
  const [d, prods, ins] = await Promise.all([api('/financas'), api('/loja/produtos'), api('/loja/insumos')]);
  const r = d.resumo; const c = d.config;
  const v = view(`<div class="sec-head"><div class="grow"><h2>Finanças com a Sol</h2><p>Margem de contribuição fica separada dos custos fixos. O resultado por produto é estimado e não é o lucro líquido da loja.</p></div><a class="btn primary" href="#conversar/sol">Perguntar à Sol</a></div>
    <div class="kpis"><div class="card kpi"><div class="l">Faturamento 30 dias</div><div class="v">${brl(r.faturamento)}</div></div><div class="card kpi"><div class="l">Margem de contribuição</div><div class="v">${brl(r.mc)}</div><div class="d">${pct(r.mc_pct)} do faturamento</div></div><div class="card kpi"><div class="l">Custos fixos do período</div><div class="v">${brl(r.custos_fixos)}</div></div><div class="card kpi"><div class="l">Resultado estimado</div><div class="v ${r.resultado < 0 ? 'down' : ''}">${brl(r.resultado)}</div><div class="d muted">estimativa</div></div></div>
    <div class="grid2"><div class="card"><h3>Por que está sobrando ${d.diagnostico.atual.resultado < d.diagnostico.anterior.resultado ? 'menos' : 'mais'}</h3><ul>${d.diagnostico.causas.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="card"><h3>Simular preço</h3><form id="simP" class="row"><label class="f grow">Custo para produzir (R$)<input name="custo" type="number" step="0.01" value="50" required></label><label class="f" style="width:150px">Resultado desejado (%)<input name="m" type="number" step="1" value="${c.margem_alvo_pct}"></label><button class="btn primary" style="align-self:end">Calcular</button></form><pre class="out" id="outP" hidden></pre>
        <h3 style="margin-top:14px">Simular desconto</h3><form id="simD" class="row"><select name="p" class="grow" style="width:auto">${prods.filter((p) => p.tipo !== 'complemento').map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select><input name="d" type="number" step="1" value="10" style="width:80px" aria-label="Desconto %"><span>%</span><button class="btn">Avaliar</button></form><pre class="out" id="outD" hidden></pre></div></div>
    <div class="card tw" style="margin-top:16px"><h3>Margem por produto</h3><table><thead><tr><th>Produto</th><th class="num">Preço</th><th class="num">Custo (CMV)</th><th class="num">Margem de contribuição</th><th class="num">Rateio fixo</th><th class="num">Resultado estimado</th><th>Base do custo</th></tr></thead><tbody>${d.margens.map((a) => `<tr><td>${esc(a.produto)}</td><td class="num">${brl(a.preco)}</td><td class="num">${a.cmv == null ? '<span class="chip bad">falta custo</span>' : brl(a.cmv)}</td><td class="num">${a.mc == null ? '—' : `${brl(a.mc)} <span class="${a.mc_pct < 0.35 ? 'down' : 'muted'}">(${pct(a.mc_pct)})</span>`}</td><td class="num">${brl(a.rateio)}</td><td class="num ${a.resultado < 0 ? 'down' : ''}">${brl(a.resultado)}</td><td class="small">${esc(a.cmv_fonte || 'informe a ficha ou o custo')}</td></tr>`).join('')}</tbody></table></div>
    <div class="grid2" style="margin-top:16px"><form class="card" id="fx"><h3>Custos fixos mensais</h3><div class="stack" id="fxl">${c.custos_fixos.map((x, i) => `<div class="row"><input name="n${i}" value="${esc(x.nome)}" class="grow" style="width:auto"><input name="v${i}" type="number" step="0.01" value="${x.valor}" style="width:120px"></div>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn sm" id="fxAdd">Adicionar custo</button><span class="grow"></span><b>Total: ${brl(d.custos_fixos_total)}</b></div>
      <h3 style="margin-top:14px">Custos variáveis e rateio</h3><div class="fgrid"><label class="f">Taxa de pagamento (%)<input name="tx" type="number" step="0.1" value="${c.variaveis.taxa_pagamento_pct}"></label><label class="f">Impostos (%)<input name="im" type="number" step="0.1" value="${c.variaveis.impostos_pct}"></label><label class="f">Comissões (%)<input name="co" type="number" step="0.1" value="${c.variaveis.comissao_pct}"></label>
        <label class="f">Base do rateio<select name="base"><option value="faturamento" ${c.rateio.base === 'faturamento' ? 'selected' : ''}>Faturamento esperado</option><option value="volume" ${c.rateio.base === 'volume' ? 'selected' : ''}>Nº de pedidos esperado</option></select></label><label class="f">Faturamento mensal esperado<input name="fe" type="number" value="${c.rateio.faturamento_mensal_esperado}"></label><label class="f">Pedidos por mês esperados<input name="pe" type="number" value="${c.rateio.pedidos_mensais_esperados}"></label></div>
      <p class="small muted">Atualize a base do rateio quando a realidade mudar. Ela muda o resultado estimado de todos os produtos.</p><button class="btn primary">Salvar</button></form>
      <div class="card tw"><h3>Insumos (custo e estoque)</h3><table><thead><tr><th>Insumo</th><th>Un.</th><th class="num">Custo</th><th class="num">Perda %</th><th class="num">Estoque</th></tr></thead><tbody>${ins.map((i) => `<tr data-i="${i.id}"><td>${esc(i.nome)}</td><td>${esc(i.unidade)}</td><td><input data-k="custo" type="number" step="0.01" value="${i.custo ?? ''}"></td><td><input data-k="perda_pct" type="number" value="${i.perda_pct ?? ''}"></td><td><input data-k="estoque" type="number" value="${i.estoque ?? ''}"></td></tr>`).join('')}</tbody></table><p class="small muted">Alterações salvam ao sair do campo.</p></div></div>`);
  $('#simP').onsubmit = async (e) => { e.preventDefault(); const x = await post('/financas/preco', { custo: e.target.custo.value, margem_alvo_pct: e.target.m.value }); const o = $('#outP'); o.hidden = false; o.textContent = x.texto; };
  $('#simD').onsubmit = async (e) => { e.preventDefault(); const x = await post('/financas/desconto', { produto_id: e.target.p.value, desconto_pct: e.target.d.value }); const o = $('#outD'); o.hidden = false; o.textContent = x.texto; };
  $('#fxAdd').onclick = () => { const i = $$('#fxl .row').length; $('#fxl').insertAdjacentHTML('beforeend', `<div class="row"><input name="n${i}" placeholder="Nome" class="grow" style="width:auto"><input name="v${i}" type="number" step="0.01" placeholder="0,00" style="width:120px"></div>`); };
  $('#fx').onsubmit = async (e) => { e.preventDefault(); const f = e.target; const custos = $$('#fxl .row').map((_, i) => ({ nome: f[`n${i}`].value, valor: Number(f[`v${i}`].value) })).filter((x) => x.nome);
    await api('/financas', { method: 'PUT', body: { custos_fixos: custos, variaveis: { taxa_pagamento_pct: +f.tx.value, impostos_pct: +f.im.value, comissao_pct: +f.co.value }, rateio: { base: f.base.value, faturamento_mensal_esperado: +f.fe.value, pedidos_mensais_esperados: +f.pe.value } } }); toast('Salvo'); VIEWS.financas(); };
  $$('tr[data-i] input', v).forEach((inp) => (inp.onchange = async () => { await api(`/insumos/${encodeURIComponent(inp.closest('tr').dataset.i)}`, { method: 'PUT', body: { [inp.dataset.k]: inp.value } }); toast('Insumo atualizado'); }));
};

// ------------------------------------------------------------------ LOJA (Alex)
VIEWS.loja = async () => {
  const [prods, s, alts, compras] = await Promise.all([api('/loja/produtos'), api('/loja/configuracoes'), api('/loja/alteracoes'), api('/alex/compras')]);
  const v = view(`<div class="sec-head"><div class="grow"><h2>Loja</h2><p>A base compartilhada que todos os agentes usam. Você pode mudar aqui ou pedir ao <a href="#conversar/alex">Alex</a>.</p></div></div>
    <div class="card tw"><h3>Produtos</h3><table><thead><tr><th>Produto</th><th>Situação</th><th class="num">Preço</th><th class="num">Estoque</th><th>Composição</th><th class="num">Margem</th><th>Ativo</th><th>Destaque</th></tr></thead><tbody>${prods.map((p) => `<tr><td><b>${esc(p.nome)}</b><div class="small muted">${esc(p.categoria)}${p.tipo === 'complemento' ? ' · complemento' : ''}${p.comemorativo ? ' · catálogo comemorativo' : ''}</div></td><td>${p.disponivel.ok ? '<span class="chip ok">à venda</span>' : `<span class="chip bad">${esc(p.disponivel.motivo)}</span>`}</td><td class="num">${brl(p.preco)}</td><td class="num"><input type="number" data-est="${esc(p.nome)}" value="${p.estoque ?? ''}" placeholder="sob encomenda" style="width:110px"></td><td class="small">${esc(p.composicao_texto || '—')}</td><td class="num">${p.margem.mc_pct != null ? pct(p.margem.mc_pct) : '<span class="chip">sem custo</span>'}</td><td><input type="checkbox" data-at="${esc(p.nome)}" ${p.ativo ? 'checked' : ''} aria-label="Ativo"></td><td><input type="checkbox" data-de="${esc(p.nome)}" ${p.destaque ? 'checked' : ''} aria-label="Destaque"></td></tr>`).join('')}</tbody></table></div>
    <div class="grid2" style="margin-top:16px">
      <div class="card"><h3>Entregas e calendário</h3>
        <p><b>Recebendo pedidos:</b> ${s.recebendo_pedidos ? 'sim' : 'pausado'} · corte para o mesmo dia ${s.corte_mesmo_dia} · capacidade ${s.capacidade_pedidos_dia} pedidos/dia</p>
        <h4>Datas bloqueadas</h4><ul>${s.datas_bloqueadas.map((b) => `<li>${dia(b.data)}: ${b.pedidos ? 'sem atendimento' : [b.entrega && 'sem entregas', b.retirada && 'sem retiradas'].filter(Boolean).join(' e ')} <button class="btn sm ghost" type="button" data-lib="${b.data}">liberar</button></li>`).join('') || '<li class="muted">Nenhuma</li>'}</ul>
        <h4>Horários especiais</h4><ul>${s.horarios_especiais.map((h) => `<li>${dia(h.data)}: ${h.abre ? `${h.abre} às ${h.fecha}` : 'fechado'}</li>`).join('') || '<li class="muted">Nenhum</li>'}</ul>
        <h4>Catálogo de data comemorativa</h4><ul>${s.modo_comemorativo.map((m) => `<li>${esc(m.nome)}: ${dia(m.inicio)} a ${dia(m.fim)}</li>`).join('') || '<li class="muted">Não programado</li>'}</ul>
        <h4>Fretes por bairro</h4><div class="row">${s.fretes.map((f) => `<span class="chip">${esc(f.bairro)} ${brl(f.valor)}</span>`).join('')}</div></div>
      <div class="card"><h3>Sugestão de compras (${dia(compras.periodo.de)} a ${dia(compras.periodo.ate)})</h3>${compras.motivo_fator ? `<p class="small">Demanda ×${compras.fator} por ${esc(compras.motivo_fator)}.</p>` : ''}
        <div class="tw"><table><thead><tr><th>Insumo</th><th class="num">Consumo</th><th class="num">Perda</th><th class="num">Estoque</th><th class="num">Comprar ~</th></tr></thead><tbody>${compras.linhas.map((l) => `<tr><td>${esc(l.insumo)}</td><td class="num">${l.consumo} ${esc(l.unidade)}</td><td class="num">${l.perda_pct}%</td><td class="num">${l.estoque}</td><td class="num"><b>${l.sugerido}</b></td></tr>`).join('')}</tbody></table></div>
        <p class="small">Custo estimado: <b>${brl(compras.custo_total)}</b></p>${compras.limitacoes.map((x) => `<p class="small muted">⚠️ ${esc(x)}</p>`).join('')}<p class="small muted">${esc(compras.aviso)}</p></div></div>
    <div class="card tw" style="margin-top:16px"><h3>Histórico de alterações</h3><table><thead><tr><th>Quando</th><th>Quem</th><th>O que mudou</th><th>Pedido original</th><th></th></tr></thead><tbody>${alts.map((c) => `<tr><td class="small">${dt(c.created_at)}</td><td>${esc(AG[c.actor]?.nome || c.actor)}</td><td>${esc(c.descricao)}</td><td class="small muted">${esc(c.comando || '—')}</td><td>${c.revertida ? '<span class="chip">desfeita</span>' : `<button class="btn sm" type="button" data-undo="${c.id}">Desfazer</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhuma alteração ainda.</td></tr>'}</tbody></table></div>`);
  const acao = async (acao, params) => { const r = await post('/loja/acao', { acao, params }); toast(r.texto || r.pergunta || 'Feito'); VIEWS.loja(); };
  $$('[data-at]', v).forEach((i) => (i.onchange = () => acao('ativar_produto', { produto: i.dataset.at, ativo: i.checked })));
  $$('[data-de]', v).forEach((i) => (i.onchange = () => acao('destacar_produto', { produto: i.dataset.de, destaque: i.checked })));
  $$('[data-est]', v).forEach((i) => (i.onchange = () => acao('atualizar_estoque', { produto: i.dataset.est, quantidade: i.value === '' ? null : Number(i.value) })));
  $$('[data-lib]', v).forEach((b) => (b.onclick = () => acao('liberar_data', { data: b.dataset.lib })));
  $$('[data-undo]', v).forEach((b) => (b.onclick = () => busy(b, async () => { await post(`/loja/alteracoes/${b.dataset.undo}/desfazer`); toast('Desfeito'); VIEWS.loja(); })));
};

// ------------------------------------------------------------------ RESULTADOS
VIEWS.resultados = async () => {
  const r = await api('/resultados'); const a = r.agentes;
  const bloco = (k, linhas) => `<div class="card" style="border-top:4px solid ${cor(k)}"><div class="row" style="margin-bottom:8px">${av(k)}<h3 style="margin:0">${AG[k].nome}</h3><span class="grow"></span><span class="small muted">~${r.tempo_por_agente_horas[k]} h economizadas</span></div><table><tbody>${linhas.map(([l, x]) => `<tr><td>${l}</td><td class="num"><b>${x}</b></td></tr>`).join('')}</tbody></table></div>`;
  view(`<div class="sec-head"><div class="grow"><h2>Resultados da fase de validação</h2><p>Últimos ${r.periodo}. O que cada agente entregou, para decidir o que realmente economiza tempo e ajuda a vender.</p></div><div class="card kpi"><div class="l">Tempo economizado (estimado)</div><div class="v">${r.tempo_economizado_horas} h</div></div></div>
    <div class="grid2">${bloco('flora', [['Conversas atendidas', a.flora.conversas], ['Pedidos criados pela Flora', a.flora.pedidos_criados], ['Valor desses pedidos', brl(a.flora.valor_pedidos)], ['Pagamentos confirmados pelo sistema', `${a.flora.pagos_confirmados} (${brl(a.flora.valor_pago)})`], ['Mensagens de recuperação', a.flora.recuperacoes_enviadas], ['Encaminhadas para uma pessoa', a.flora.encaminhadas_para_pessoa]])}
      ${bloco('mari', [['Peças criadas', a.mari.pecas_criadas], ['Publicadas', a.mari.publicadas], ['Aguardando aprovação', a.mari.aguardando], ['Pausadas por produto indisponível', a.mari.pausadas_por_indisponibilidade]])}
      ${bloco('caio', [['Gasto em mídia (7 dias)', brl(a.caio.gasto_7d)], ['Compras identificáveis', a.caio.compras_identificaveis], ['Receita identificável', brl(a.caio.receita_identificavel)], ['ROAS', a.caio.roas], ['Campanhas pausadas', a.caio.pausas], ['Teto diário respeitado', brl(a.caio.teto_diario)]])}
      ${bloco('alex', [['Alterações executadas', a.alex.alteracoes], ['Desfeitas', a.alex.desfeitas], ['Recomendações', a.alex.recomendacoes], ['Executadas', a.alex.recomendacoes_executadas], ['Com resultado revisado', a.alex.revisadas]])}
      ${bloco('sol', [['Consultas respondidas', a.sol.consultas]])}
      <div class="card"><h3>Como ler estes números</h3><ul>${r.avisos.map((x) => `<li class="small">${esc(x)}</li>`).join('')}</ul></div></div>`);
};

// ------------------------------------------------------------------ CONFIGURAR
const FORMS = {
  alex: [['Metas', [['metas.faturamento_mensal', 'Faturamento mensal (R$)', 'number'], ['metas.pedidos_mes', 'Pedidos por mês', 'number'], ['metas.ticket_medio', 'Ticket médio (R$)', 'number']]], ['Rotina', [['resumo_diario.horario', 'Horário do resumo diário', 'time'], ['resumo_diario.whatsapp_dono', 'WhatsApp do dono', 'text'], ['confirmar_lote_acima', 'Pedir confirmação em lotes acima de', 'number']]],
    ['Permissões (o que o Alex pode alterar)', [['permissoes.produtos', 'Ativar e desativar produtos', 'bool'], ['permissoes.estoque', 'Estoque', 'bool'], ['permissoes.categorias', 'Categorias e destaques', 'bool'], ['permissoes.horarios', 'Horários especiais', 'bool'], ['permissoes.datas', 'Bloquear datas', 'bool'], ['permissoes.pedidos', 'Pausar pedidos', 'bool'], ['permissoes.data_comemorativa', 'Catálogo comemorativo', 'bool'], ['permissoes.fretes', 'Fretes', 'bool']]],
    ['Compras', [['compras.dias_cobertura', 'Dias de cobertura', 'number'], ['compras.perda_padrao_pct', 'Perda padrão (%)', 'number'], ['compras.fator_data_comemorativa', 'Multiplicador em datas fortes', 'number']]], ['Instruções', [['instrucoes', 'Instruções para o Alex', 'textarea']]]],
  flora: [['Canais', [['canais.whatsapp', 'WhatsApp', 'bool'], ['canais.chat_loja', 'Chat da loja', 'bool']]], ['Jeito de atender', [['tom', 'Tom de voz', 'text'], ['saudacao', 'Saudação ({loja} = nome da loja)', 'textarea']]],
    ['Vendas', [['fazer_upsell', 'Oferecer complementos', 'bool'], ['desconto_maximo_pct', 'Desconto máximo autorizado (%)', 'number'], ['transferir_quando', 'Encaminhar para uma pessoa quando', 'textarea']]],
    ['Recuperação e recompra', [['recuperar_abandonos', 'Recuperar conversas e pagamentos parados', 'bool'], ['horas_para_recuperar', 'Depois de quantas horas', 'number'], ['recompra.ativa', 'Lembrete de recompra (só para quem autorizou)', 'bool'], ['recompra.dias_antes', 'Dias antes da data', 'number']]], ['Instruções', [['instrucoes', 'Instruções para a Flora', 'textarea']]]],
  mari: [['Frequência', [['feed_semana', 'Posts no feed por semana', 'number'], ['carrosseis_semana', 'Carrosséis por semana', 'number'], ['stories_dia', 'Stories por dia', 'number']]], ['Aprovação', [['aprovacao', 'Como aprovar', 'select:individual,lote,automatica']]],
    ['Identidade', [['tom', 'Tom de voz', 'text'], ['cores_marca', 'Cores da marca', 'colors'], ['hashtags', 'Hashtags fixas', 'list'], ['repetir_foto_apos_dias', 'Repetir uma foto só depois de (dias)', 'number']]], ['Instruções', [['instrucoes', 'Instruções para a Mari', 'textarea']]]],
  caio: [['Limites financeiros', [['teto_diario', 'Teto diário (R$)', 'number'], ['teto_mensal', 'Teto mensal (R$)', 'number'], ['autonomia', 'Autonomia', 'select:sugerir,ajustar_dentro_do_teto']]], ['Plataformas', [['plataformas.meta', 'Meta (Facebook e Instagram)', 'bool'], ['plataformas.google', 'Google', 'bool']]],
    ['Regras', [['cpa_maximo', 'Custo por venda máximo (R$)', 'number'], ['regras.pausar_sem_venda_apos_gasto', 'Pausar sem venda após gastar (R$)', 'number'], ['regras.pausar_ctr_abaixo', 'Pausar com taxa de cliques abaixo de (%)', 'number'], ['regras.escalar_roas_acima', 'Aumentar verba com ROAS acima de', 'number'], ['margem_minima_para_escalar_pct', 'Margem mínima para aumentar verba (%)', 'number']]], ['Região', [['regiao.cidade', 'Cidade', 'text'], ['regiao.raio_km', 'Raio (km)', 'number']]]],
  sol: [['Meta de resultado', [['margem_alvo_pct', 'Resultado desejado por produto após rateio (%)', 'number']]]],
};
const gp = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const sp = (o, p, v) => { const ks = p.split('.'); let x = o; ks.slice(0, -1).forEach((k) => { x = x[k] ??= {}; }); x[ks.at(-1)] = v; };
function campo([k, l, t], cfg) {
  const v = gp(cfg, k); const n = `f_${k}`;
  if (t === 'bool') return `<label class="check"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}> ${l}</label>`;
  if (t === 'textarea') return `<label class="f" style="grid-column:1/-1">${l}<textarea name="${n}">${esc(v)}</textarea></label>`;
  if (t === 'list') return `<label class="f">${l}<input name="${n}" value="${esc((v || []).join(', '))}"></label>`;
  if (t === 'colors') return `<div class="f">${l}<div class="row">${[0, 1, 2].map((i) => `<input type="color" name="${n}" value="${esc(v?.[i] || '#ffffff')}" style="width:52px;height:34px;padding:2px">`).join('')}</div></div>`;
  if (t.startsWith('select:')) return `<label class="f">${l}<select name="${n}">${t.slice(7).split(',').map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  return `<label class="f">${l}<input type="${t}" ${t === 'number' ? 'step="any"' : ''} name="${n}" value="${esc(v)}"></label>`;
}
function ler([k, , t], f, out) {
  const n = `f_${k}`;
  const v = t === 'bool' ? f.elements[n].checked : t === 'list' ? f.elements[n].value.split(',').map((x) => x.trim()).filter(Boolean) : t === 'colors' ? $$(`[name="${n}"]`, f).map((i) => i.value) : t === 'number' ? Number(f.elements[n].value) : f.elements[n].value;
  sp(out, k, v);
}
VIEWS.configurar = async () => {
  const k = location.hash.split('/')[1] || 'alex';
  const [cfg, eq] = await Promise.all([api(`/agentes/${k}/config`), api('/equipe')]);
  const ag = eq.equipe.find((a) => a.key === k);
  const t = ME.tenant;
  const v = view(`<div class="row" style="margin-bottom:14px">${Object.keys(AG).map((x) => `<a class="btn ${x === k ? 'primary' : ''}" href="#configurar/${x}">${AG[x].nome}</a>`).join('')}</div>
    <form class="card" id="cf"><div class="sec-head">${av(k)}<div class="grow"><h2>${AG[k].nome} · ${esc(ag.cargo)}</h2><p>${esc(ag.resumo)}</p></div>
      <label class="check"><input type="checkbox" name="hire" ${ag.contratado ? 'checked' : ''}> Contratado</label><label class="check"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}> Ligado</label></div>
      ${FORMS[k].map(([tt, fs]) => `<fieldset><legend>${tt}</legend><div class="fgrid">${fs.map((f) => campo(f, cfg)).join('')}</div></fieldset>`).join('')}
      ${k === 'sol' ? '<p class="small muted">Custos fixos, custos variáveis e rateio ficam em <a href="#financas">Finanças</a>.</p>' : ''}<button class="btn primary">Salvar</button></form>
    <div class="card" style="margin-top:16px"><h3>Integrações da loja</h3><p class="small muted">${t.demo ? 'Na demonstração, as integrações não conectam de verdade.' : 'Conecte as contas que os agentes vão usar.'}</p>
      <div class="grid2">${[['iflores', 'Sistema iFlores', [['base_url', 'URL da API'], ['token', 'Token da loja']], t.iflores], ['whatsapp', 'WhatsApp Business (Flora)', [['phone_number_id', 'Phone Number ID'], ['access_token', 'Token de acesso']], t.integrations.whatsapp], ['instagram', 'Instagram (Mari)', [['ig_user_id', 'ID da conta Business'], ['access_token', 'Token de acesso']], t.integrations.instagram], ['meta_ads', 'Meta Ads (Caio)', [['ad_account_id', 'Conta de anúncios'], ['access_token', 'Token (System User)']], t.integrations.meta_ads], ['google_ads', 'Google Ads (Caio)', [['customer_id', 'Customer ID'], ['access_token', 'Token OAuth']], t.integrations.google_ads]]
        .map(([key, nome, fs, cur]) => `<form class="stack" data-int="${key}" style="border:1px solid var(--line);border-radius:12px;padding:12px"><div class="row"><b class="grow">${nome}</b><span class="chip ${cur?.connected ? 'ok' : ''}">${cur?.connected ? 'conectado' : 'não conectado'}</span></div>${fs.map(([n, l]) => `<label class="f">${l}<input name="${n}" value="${esc(cur?.[n] || '')}"></label>`).join('')}<button class="btn">Conectar</button></form>`).join('')}</div></div>`);
  $('#cf').onsubmit = async (e) => { e.preventDefault(); const out = { enabled: e.target.enabled.checked }; FORMS[k].forEach(([, fs]) => fs.forEach((f) => ler(f, e.target, out))); await api(`/agentes/${k}/config`, { method: 'PUT', body: out }); if (e.target.hire.checked !== ag.contratado) await post(`/agentes/${k}/contratar`, { contratado: e.target.hire.checked }); toast('Configurações salvas'); };
  $$('[data-int]', v).forEach((f) => (f.onsubmit = async (e) => { e.preventDefault(); const r = await api(`/integracoes/${f.dataset.int}`, { method: 'PUT', body: Object.fromEntries(new FormData(f)) }); toast(r.ok ? 'Conectado' : r.mensagem); if (r.ok) { ME.tenant = r.tenant; VIEWS.configurar(); } }));
};

boot();
