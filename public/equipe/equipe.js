// Minha equipe — a vitrine da Equipe dos Sonhos para o lojista.
// Cada personagem da loja abre o agente com os dados reais da loja (API /api/v1).
// "Tarefas" e "Configurações" abrem o painel completo (CRM) em /painel/crm.
const $ = (s) => document.querySelector(s);
const panel = $('#panel');

// ---------------------------------------------------------------- sessão
let TOKEN = null;
try {
  const url = new URLSearchParams(location.search).get('token');
  TOKEN = url || sessionStorage.getItem('eq_token');
  if (url) { sessionStorage.setItem('eq_token', url); history.replaceState(null, '', location.pathname + location.hash); }
} catch { /* sem sessionStorage: segue só com o token da URL */ }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status });
  return data;
}
const crm = (secao) => `/painel/crm#${secao}`;

// ---------------------------------------------------------------- personalização (só a cor e o nome da fachada ficam no navegador)
let state = { name: 'Sua floricultura', color: '#76213c' };
try { Object.assign(state, JSON.parse(localStorage.getItem('iflores-fachada') || '{}')); } catch { /* sem armazenamento */ }
function save() { try { localStorage.setItem('iflores-fachada', JSON.stringify({ color: state.color, name: state.name })); } catch { /* sem armazenamento */ } }

// ---------------------------------------------------------------- utilitários usados também pelo catalog.js
function toast(t) { $('#toast').textContent = t; $('#toast').classList.add('show'); clearTimeout(window.tt); window.tt = setTimeout(() => $('#toast').classList.remove('show'), 3500); }
function escapeHTML(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function modal(html) { $('#modal-body').innerHTML = html; $('#modal').showModal(); }
const esc = escapeHTML;
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v) => `${(Number(v || 0) * 100).toFixed(1).replace('.', ',')}%`;
const sinal = (v) => `${v >= 0 ? '+' : ''}${pct(v)}`;

function brand() {
  document.documentElement.style.setProperty('--facade', state.color);
  $('#shop-title').textContent = state.name; $('#sign-name').textContent = state.name;
  $('.avatar').textContent = state.name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();
}

// ---------------------------------------------------------------- sprites em pixel art (mesmo desenho do protótipo aprovado)
function sprite(canvas, role) {
  const c = canvas.getContext('2d'); c.clearRect(0, 0, 24, 36);
  const skin = role === 'sales' ? '#b87a52' : '#e7ae7e'; const hair = role === 'social' ? '#754228' : '#392923';
  const shirt = ({ traffic: '#52616a', manager: '#eee6d8', social: '#648468', sales: '#f3e9d8', florist: '#f1e8dc' })[role];
  const r = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
  r(7, 3, 11, 4, hair); r(5, 6, 15, 9, hair); r(7, 8, 11, 9, skin); r(6, 6, 12, 4, hair); r(5, 10, 3, 5, hair); r(10, 11, 2, 2, '#342629'); r(16, 11, 2, 2, '#342629'); r(13, 15, 3, 1, '#aa6b56');
  if (role === 'social' || role === 'sales') r(4, 8, 3, 15, hair);
  r(10, 17, 5, 2, skin); r(6, 19, 13, 10, shirt); r(5, 20, 3, 8, shirt); r(19, 20, 3, 6, shirt); r(6, 28, 6, 6, '#384348'); r(14, 28, 5, 6, '#384348'); r(5, 33, 8, 3, '#292827'); r(14, 33, 7, 3, '#292827');
  if (['sales', 'florist'].includes(role)) { r(9, 20, 8, 10, '#8e3745'); r(9, 18, 2, 5, '#8e3745'); }
  if (role === 'manager') { r(12, 19, 2, 8, '#6f2b3c'); r(14, 23, 8, 8, '#9e754e'); r(15, 24, 6, 5, '#e6d8b4'); r(18, 24, 4, 3, skin); }
  else if (role === 'social') { r(19, 17, 4, 7, '#272f30'); r(20, 18, 2, 4, '#bec5bd'); r(17, 23, 4, 3, skin); }
  else if (role === 'florist') { r(14, 24, 8, 3, '#48784a'); r(19, 20, 4, 5, '#cb788d'); r(16, 21, 4, 3, '#ebb1b9'); }
  else { r(17, 26, 6, 3, skin); }
  if (role === 'traffic') { r(9, 10, 5, 4, '#242c30'); r(15, 10, 5, 4, '#242c30'); r(10, 11, 3, 2, '#b9bcab'); r(16, 11, 3, 2, '#b9bcab'); }
}
function sprites() { document.querySelectorAll('[data-sprite]').forEach((c) => sprite(c, c.dataset.sprite)); }

// ---------------------------------------------------------------- agentes
// personagem da cena → agente da Equipe dos Sonhos
const AGENTE = { manager: 'alex', traffic: 'caio', social: 'mari', sales: 'flora' };
const roles = {
  manager: ['Alex · Gerente', 'Seu próximo passo, com clareza.', 'Reúno os números da sua loja e transformo em prioridades. Só executo o que você autorizar.', 'Seu plano de hoje'],
  traffic: ['Caio · Anúncios', 'Meta e Google', 'Cuido das campanhas dentro do teto de gasto que você define. Nunca aumento o teto sem sua autorização.', 'Suas campanhas'],
  social: ['Mari · Conteúdo', 'Feed e Stories com a cara da sua loja', 'Transformo as fotos da loja em posts e stories. Você aprova antes de publicar.', 'Aguardando sua aprovação'],
  sales: ['Atendimento', 'Contatos e funil de vendas', 'O atendimento no WhatsApp é feito pelo agente da iFlores. Aqui você acompanha os contatos e em que etapa cada um está.', 'Seu funil'],
};
let current = 'manager'; let equipe = null;

const statusDe = (role) => {
  const a = equipe?.equipe?.find((x) => x.key === AGENTE[role]);
  if (!a) return roles[role][1];
  if (!a.contratado) return 'Não contratado';
  if (a.status === 'pausado') return 'Pausado';
  return `${a.status === 'trabalhando' ? 'Trabalhando agora' : 'Online'}${a.pendentes ? ` · ${a.pendentes} pendência(s)` : ''}`;
};

async function render(role) {
  current = role;
  document.querySelectorAll('.person').forEach((b) => b.classList.toggle('selected', b.dataset.person === role));
  const d = roles[role];
  panel.innerHTML = `<div class="panel-head"><div class="portrait portrait-${role}" aria-hidden="true"></div><div><h2>${d[0]}</h2><span class="status">● ${esc(statusDe(role))}</span></div></div>
    <p class="description">${d[2]}</p><div class="tabs"><span>${d[3]}</span></div><div id="panel-content"><p class="fine">Carregando…</p></div>`;
  const out = $('#panel-content');
  if (!TOKEN) { out.innerHTML = semLoja(); ligarDemo(); return; }
  try { await PAINEIS[role](out); } catch (e) { out.innerHTML = `<div class="task"><h3>Não consegui carregar agora</h3><p>${esc(e.message)}</p></div>`; }
  sprites();
}

const semLoja = () => `<div class="task"><small>DEMONSTRAÇÃO</small><h3>Conheça a equipe com uma loja de exemplo</h3><p>Dados de exemplo para você ver cada agente trabalhando. Na sua loja, este painel abre direto pela iFlores.</p></div><button class="primary" id="abrir-demo">Abrir loja de demonstração</button>`;
function ligarDemo() {
  const b = $('#abrir-demo'); if (!b) return;
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Preparando a loja…';
    const r = await fetch('/api/v1/demo', { method: 'POST' }).then((x) => x.json()).catch(() => ({}));
    if (!r.token) { b.disabled = false; b.textContent = 'Tentar de novo'; toast('Não foi possível abrir a demonstração agora.'); return; }
    try { sessionStorage.setItem('eq_token', r.token); } catch { /* segue */ }
    TOKEN = r.token; await iniciar();
  };
}

// ---------------------------------------------------------------- Alex
function cincoPartes(r) {
  const fatos = (r.fatos || []).map((f) => `<li>${esc(f)}</li>`).join('');
  return `<span class="panel-kicker">RECOMENDAÇÃO DO ALEX · CONFIANÇA ${esc((r.confianca || '').toUpperCase())}</span>
    <h2 style="margin-top:12px">${esc(r.titulo)}</h2>
    <div class="task"><small>1 · O DADO</small><p>${esc(r.dado)}</p>${fatos ? `<ul class="fatos">${fatos}</ul>` : ''}${(r.hipoteses || []).length ? `<p><b>Hipóteses (não confirmadas):</b> ${esc(r.hipoteses.join(' '))}</p>` : ''}</div>
    <div class="task"><small>2 · O QUE PODE SIGNIFICAR</small><p>${esc(r.interpretacao)}</p></div>
    <div class="task"><small>3 · RECOMENDAÇÃO</small><p>${esc(r.recomendacao)}</p></div>
    <div class="task"><small>4 · SUA AUTORIZAÇÃO</small><p>${esc(r.autorizacao?.pergunta || 'Não há ação automática: depende de você.')}</p></div>
    <div class="task"><small>5 · ACOMPANHAMENTO</small><p>${esc(r.acompanhamento?.descricao || '')}</p></div>
    ${(r.limitacoes || []).length ? `<p class="fine">Limitações: ${esc(r.limitacoes.join(' '))}</p>` : ''}`;
}

async function painelAlex(out) {
  const recs = (await api('/tarefas?tipo=recomendacao&status=aguardando_dono')).slice(0, 3);
  out.innerHTML = `${recs.length ? recs.map((t, i) => `<div class="task"><small>PRIORIDADE 0${i + 1}${t.recomendacao?.confianca ? ` · CONFIANÇA ${esc(t.recomendacao.confianca.toUpperCase())}` : ''}</small><h3>${esc(t.titulo)}</h3><p>${esc(String(t.recomendacao?.recomendacao || t.detalhes || '').slice(0, 170))}</p>
      <div class="acoes"><button data-entender="${esc(t.id)}">Entender →</button>${t.recomendacao?.autorizacao?.acao ? `<button data-aprovar="${esc(t.id)}">Autorizar</button>` : `<button data-aprovar="${esc(t.id)}">Marcar como feito</button>`}</div></div>`).join('')
    : '<div class="task"><small>TUDO EM DIA</small><h3>Nenhuma recomendação nova</h3><p>Quando eu encontrar algo nos números, aviso no canto da tela e aqui.</p></div>'}
    <div class="conversa"><div id="msgs-alex"></div>
      <div class="sugestoes">${['Minhas vendas caíram. O que devo fazer?', 'Qual produto devo divulgar esta semana?', 'Vale a pena fazer uma promoção?'].map((s) => `<button type="button" data-ex="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <form class="chat-input" id="chat-alex"><input id="msg-alex" aria-label="Mensagem para o Alex" placeholder="Peça algo ao Alex…" required maxlength="400"><button aria-label="Enviar">→</button></form></div>
    <button class="primary" id="semana">Ver a semana em números</button>
    <button class="secondary" id="ver-tarefas">Ver todas as tarefas e indicadores</button>`;
  const detalhe = Object.fromEntries(recs.map((t) => [t.id, t]));
  out.querySelectorAll('[data-entender]').forEach((b) => { b.onclick = () => modal(cincoPartes(detalhe[b.dataset.entender].recomendacao)); });
  out.querySelectorAll('[data-aprovar]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'Executando…';
      try { const r = await api(`/tarefas/${encodeURIComponent(b.dataset.aprovar)}/aprovar`, { method: 'POST' }); toast(r.texto || 'Feito.'); } catch (e) { toast(e.message); }
      atualizarEquipe(); render('manager');
    };
  });
  const enviar = async (texto) => {
    const box = $('#msgs-alex');
    const eu = document.createElement('div'); eu.className = 'bubble reply'; eu.textContent = texto; box.append(eu);
    const ele = document.createElement('div'); ele.className = 'bubble'; ele.textContent = '…'; box.append(ele);
    try { const r = await api('/agentes/alex/conversar', { method: 'POST', body: { texto } }); ele.textContent = r.texto; } catch (e) { ele.textContent = e.message; }
    ele.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  $('#chat-alex').onsubmit = (e) => { e.preventDefault(); const t = $('#msg-alex').value.trim(); if (t) { $('#msg-alex').value = ''; enviar(t); } };
  out.querySelectorAll('[data-ex]').forEach((b) => { b.onclick = () => enviar(b.dataset.ex); });
  $('#ver-tarefas').onclick = () => { location.href = crm('tarefas'); };
  $('#semana').onclick = async () => {
    const s = await api('/alex/semana');
    const v = s.variacoes || {}; const a = s.atual || {};
    const kpi = (l, val, d) => `<div class="kpi"><small>${l}</small><b>${val}</b>${d == null ? '' : `<span class="${d >= 0 ? 'up' : 'down'}">${sinal(d)}</span>`}</div>`;
    modal(`<span class="panel-kicker">ÚLTIMOS 7 DIAS · COMPARADOS COM OS 7 ANTERIORES</span><h2 style="margin-top:12px">A semana da loja</h2>
      <div class="kpis">${kpi('Faturamento', brl(a.faturamento), v.faturamento)}${kpi('Pedidos', a.pedidos ?? 0, v.pedidos)}${kpi('Ticket médio', brl(a.ticket), v.ticket)}${kpi('Conversão', pct(a.conversao), v.conversao)}</div>
      ${(s.top || []).length ? `<h3>Mais vendidos</h3>${s.top.map((x) => `<div class="plan-item"><span>${esc(x.nome)}</span><b>${x.qtd}</b></div>`).join('')}` : ''}
      <button class="primary" onclick="location.href='${crm('resultados')}'">Abrir relatório completo</button>`);
  };
}

// ---------------------------------------------------------------- Caio
async function painelCaio(out) {
  const d = await api('/anuncios');
  const cs = d.campanhas || [];
  out.innerHTML = `${cs.length ? cs.slice(0, 4).map((c) => `<div class="plan-item"><span><b>${esc(c.nome)}</b><br><small>${esc(c.plataforma === 'meta' ? 'Meta' : 'Google')} · ${brl(c.orcamento_diario)}/dia · ROAS ${Number(c.metricas?.roas || 0).toFixed(1).replace('.', ',')}</small></span><span class="pill ${c.status === 'ativa' ? 'ok' : ''}">${esc(c.status)}</span></div>`).join('') : '<div class="task"><h3>Nenhuma campanha ainda</h3><p>O Caio propõe campanhas para você aprovar.</p></div>'}
    <form id="teto"><label for="teto-diario">Teto de gasto por dia (R$)</label><input id="teto-diario" type="number" min="1" step="1" required value="${Number(d.config?.teto_diario || 0)}">
      <label for="cidade">Região atendida</label><input id="cidade" required value="${esc(d.config?.regiao?.cidade || '')}">
      <button class="primary">Salvar teto e região</button></form>
    <p class="fine">Verba de teste sugerida: ${brl(d.verba_teste?.diaria)}/dia por ${d.verba_teste?.semanas || 2} semanas. O Caio nunca passa do teto sem a sua autorização.</p>
    <button class="secondary" id="ver-anuncios">Ver anúncios e propostas no painel</button>`;
  $('#teto').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/agentes/caio/config', { method: 'PUT', body: { teto_diario: Number($('#teto-diario').value), regiao: { cidade: $('#cidade').value.trim() } } }); toast('Teto e região salvos.'); } catch (err) { toast(err.message); }
  };
  $('#ver-anuncios').onclick = () => { location.href = crm('anuncios'); };
}

// ---------------------------------------------------------------- Mari
async function painelMari(out) {
  const posts = await api('/conteudo/posts?status=aguardando_aprovacao');
  const cfg = await api('/agentes/mari/config');
  out.innerHTML = `${posts.length ? `<div class="mini-grid">${posts.slice(0, 6).map((p) => `<button class="peca" data-post="${esc(p.id)}" title="${esc(p.slides?.[0]?.titulo || '')}"><img src="${p.slides?.[0]?.imagem || ''}" alt="${esc(p.slides?.[0]?.titulo || 'Peça')}"></button>`).join('')}</div>
      <p class="fine">${posts.length} peça(s) esperando você. Toque numa peça para ver a legenda.</p>
      <button class="primary" id="aprovar-todas">Aprovar ${posts.length > 1 ? `as ${posts.length} peças` : 'a peça'}</button>`
    : '<div class="task"><h3>Nada esperando aprovação</h3><p>Peça à Mari para preparar a próxima semana.</p></div>'}
    <label for="freq">Posts no feed por semana</label><select id="freq">${[3, 5, 7].map((n) => `<option value="${n}" ${Number(cfg.feed_semana) === n ? 'selected' : ''}>${n} por semana</option>`).join('')}</select>
    <label class="mode"><input type="checkbox" id="auto" ${cfg.aprovacao === 'automatica' ? 'checked' : ''}>Publicar sem pedir aprovação</label>
    <button class="secondary" id="preparar">Preparar a próxima semana</button>
    <button class="secondary" id="ver-conteudo">Ver todo o conteúdo no painel</button>`;
  const porId = Object.fromEntries(posts.map((p) => [p.id, p]));
  out.querySelectorAll('[data-post]').forEach((b) => {
    b.onclick = () => { const p = porId[b.dataset.post]; modal(`<h2>${esc(p.slides?.[0]?.titulo || 'Peça')}</h2><img class="peca-grande" src="${p.slides?.[0]?.imagem || ''}" alt=""><p class="description" style="white-space:pre-line">${esc(p.legenda || '')}</p>`); };
  });
  const aprovar = $('#aprovar-todas');
  if (aprovar) aprovar.onclick = async () => { aprovar.disabled = true; await api('/conteudo/aprovar', { method: 'POST', body: { ids: posts.map((p) => p.id) } }); toast('Peças aprovadas e agendadas.'); render('social'); };
  $('#freq').onchange = async (e) => { await api('/agentes/mari/config', { method: 'PUT', body: { feed_semana: Number(e.target.value) } }); toast('Frequência salva.'); };
  $('#auto').onchange = async (e) => { await api('/agentes/mari/config', { method: 'PUT', body: { aprovacao: e.target.checked ? 'automatica' : 'lote' } }); toast(e.target.checked ? 'A Mari vai publicar sem pedir aprovação.' : 'Cada peça vai esperar sua aprovação.'); };
  $('#preparar').onclick = async () => { $('#preparar').disabled = true; toast('A Mari está preparando a semana…'); try { await api('/agentes/mari/executar', { method: 'POST' }); } catch (e) { toast(e.message); } render('social'); };
  $('#ver-conteudo').onclick = () => { location.href = crm('conteudo'); };
}

// ---------------------------------------------------------------- Atendimento (CRM)
async function painelAtendimento(out) {
  const f = await api('/crm/funil');
  const nomes = f.etapas || {}; const cont = f.contagem || {};
  const total = Object.values(cont).reduce((s, n) => s + n, 0) || 1;
  out.innerHTML = `${Object.keys(nomes).map((k) => `<div class="funil"><span>${esc(nomes[k])}</span><b>${cont[k] || 0}</b><i style="width:${Math.round(((cont[k] || 0) / total) * 100)}%"></i></div>`).join('')}
    <p class="fine">As etapas são calculadas pelas conversas e pelos pedidos de cada contato.</p>
    <button class="primary" id="ver-crm">Abrir contatos no CRM</button>`;
  $('#ver-crm').onclick = () => { location.href = crm('crm'); };
}

const PAINEIS = { manager: painelAlex, traffic: painelCaio, social: painelMari, sales: painelAtendimento };

// ---------------------------------------------------------------- cabeçalho, fachada e navegação
async function atualizarEquipe() {
  try {
    equipe = await api('/equipe');
    const n = equipe.pendencias || 0;
    $('#badge-tarefas').textContent = n ? String(n) : '';
  } catch { /* segue sem os números */ }
}

async function iniciar() {
  document.body.classList.toggle('sem-loja', !TOKEN);
  if (TOKEN) {
    try {
      const me = await api('/me');
      state.name = me.tenant?.name || state.name; brand();
      $('#modo').textContent = me.ai?.enabled ? 'IA ativa' : me.tenant?.demo ? 'Loja de demonstração' : 'Modo sem IA';
      await atualizarEquipe();
    } catch (e) {
      if (e.status === 401) { TOKEN = null; try { sessionStorage.removeItem('eq_token'); } catch { /* segue */ } }
    }
  }
  render(current);
}

function customize() {
  modal(`<h2>A fachada da sua loja</h2><p class="description">O nome e a cor da faixa que aparecem na loja.</p><form id="brand-form"><label for="shopname">Nome da floricultura</label><input id="shopname" maxlength="32" required value="${esc(state.name)}"><label for="shopcolor">Cor da faixa da fachada</label><input type="color" id="shopcolor" value="${esc(state.color)}"><button class="primary">Salvar</button></form>`);
  $('#brand-form').onsubmit = (e) => { e.preventDefault(); state.name = $('#shopname').value.trim() || state.name; state.color = $('#shopcolor').value; save(); brand(); $('#modal').close(); toast('Fachada atualizada.'); };
}

$('#close-modal').onclick = () => $('#modal').close();
$('#modal').onclick = (e) => { if (e.target === $('#modal')) $('#modal').close(); };
$('#personalize').onclick = customize;
$('#customize').onclick = customize;
$('#btn-tarefas').onclick = () => { location.href = crm('tarefas'); };
$('#btn-config').onclick = () => { location.href = crm('configurar'); };
document.querySelectorAll('[data-person]').forEach((b) => { b.onclick = () => { render(b.dataset.person); if (innerWidth < 761) panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; });
document.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => { if (b.dataset.nav === 'team') render('manager'); }; });
setInterval(() => { if (TOKEN && !document.hidden) atualizarEquipe(); }, 30000);
brand(); sprites(); iniciar();
