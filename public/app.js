// Painel da Equipe Virtual iFlores (sem build: JS puro).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const ago = (iso) => { if (!iso) return ''; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'agora'; if (s < 3600) return `${Math.floor(s / 60)} min`; if (s < 86400) return `${Math.floor(s / 3600)} h`; return new Date(iso).toLocaleDateString('pt-BR'); };
const dt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

let TOKEN = new URLSearchParams(location.search).get('token') || sessionStorageGet('token');
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* sem storage */ } }

const AGENT_META = {};
let STATE = { team: null, me: null, feed: [] };

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method || 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
async function withBusy(btn, fn) { const txt = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Trabalhando…'; } try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn) { btn.disabled = false; btn.textContent = txt; } } }

// ------------------------------------------------------------------ boot
async function boot() {
  if (!TOKEN) { $('#login').classList.remove('hidden'); return; }
  try { STATE.me = await api('/me'); } catch { TOKEN = null; $('#login').classList.remove('hidden'); return; }
  sessionStorageSet('token', TOKEN);
  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
  $('#app').classList.remove('hidden');
  $('#storeName').textContent = STATE.me.tenant.name;
  if (STATE.me.tenant.brand?.primary) document.documentElement.style.setProperty('--primary', STATE.me.tenant.brand.primary);
  const ai = $('#aiPill'); ai.textContent = STATE.me.ai.enabled ? `IA ativa · ${STATE.me.ai.model}` : 'Modo demonstração';
  ai.classList.toggle('on', STATE.me.ai.enabled);
  (await api('/agents')).forEach((a) => { AGENT_META[a.key] = a; });
  connectStream();
  window.addEventListener('hashchange', route);
  route();
}
$('#btnDemo').onclick = async () => { const r = await fetch('/api/v1/demo', { method: 'POST' }).then((x) => x.json()); TOKEN = r.token; $('#login').classList.add('hidden'); boot(); };

function connectStream() {
  const es = new EventSource(`/api/v1/stream?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === 'activity') {
      STATE.feed.unshift(ev.item); STATE.feed = STATE.feed.slice(0, 80);
      const f = $('#feed'); if (f) f.insertAdjacentHTML('afterbegin', feedItem(ev.item));
      debounceRefresh();
    }
    if (ev.kind === 'status') {
      const card = document.querySelector(`.agent[data-key="${ev.agent}"]`);
      if (card) {
        const st = $('.status', card); st.className = `status ${ev.status === 'trabalhando' ? 'trabalhando' : 'online'}`; st.textContent = ev.status === 'trabalhando' ? 'Trabalhando' : 'Online';
        if (ev.current) $('.now', card).textContent = ev.current;
      }
    }
  };
}
let _rt; function debounceRefresh() { clearTimeout(_rt); _rt = setTimeout(() => { if (currentTab() === 'team') renderTeam(true); updateBadges(); }, 1500); }

const currentTab = () => (location.hash.slice(1) || 'team');
function route() {
  const tab = currentTab();
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const views = { team: renderTeam, tasks: renderTasks, content: renderContent, chat: renderChat, ads: renderAds, goals: renderGoals, config: renderConfig, integrations: renderIntegrations };
  (views[tab] || renderTeam)();
  updateBadges();
}
async function updateBadges() {
  try {
    const [tasks, posts] = await Promise.all([api('/tasks?status=review'), api('/posts?status=aguardando_aprovacao')]);
    $('#bTasks').textContent = tasks.length || ''; $('#bContent').textContent = posts.length || '';
  } catch { /* ignora */ }
}

// ------------------------------------------------------------------ EQUIPE
const ICONS = { gerente: '👩‍💼', trafego: '📈', social: '🎨', atendente: '💬' };
function feedItem(a) {
  return `<div class="feed-item ${esc(a.level)}"><div class="ic">${ICONS[a.agent] || '•'}</div><div><div class="msg">${esc(a.message)}</div><time>${esc(AGENT_META[a.agent]?.config?.nome_exibicao || a.agent)} · ${ago(a.created_at)}</time></div></div>`;
}
function kpiCard(k) {
  const v = k.fmt === 'brl' ? brl(k.valor) : k.fmt === '%' ? `${k.valor}%` : k.fmt === 'x' ? `${k.valor}x` : k.fmt === 'seg' ? `${k.valor}s` : k.valor;
  const m = k.fmt === 'brl' ? brl(k.meta) : k.fmt === '%' ? `${k.meta}%` : k.fmt === 'x' ? `${k.meta}x` : k.fmt === 'seg' ? `${k.meta}s` : k.meta;
  const p = Math.min(100, k.progresso || 0); const cls = p >= 90 ? '' : p >= 60 ? 'mid' : 'low';
  return `<div class="card kpi"><div class="label">${esc(k.label)}</div><div class="value">${esc(v)}</div><div class="meta">Meta ${k.menor_melhor ? 'até' : ''} ${esc(m)}${k.projecao ? ` · projeção ${brl(k.projecao)}` : ''}</div><div class="bar"><i class="${cls}" style="width:${p}%"></i></div></div>`;
}
function agentCard(a) {
  return `<div class="card agent" data-key="${a.key}" style="--c:${a.cor}">
    <div class="head"><div class="avatar">${a.avatar}</div><div style="flex:1;min-width:0"><div class="name">${esc(a.nome_exibicao)} <span class="muted" style="font-weight:400">· ${esc(a.nome)}</span></div><div class="role">${esc(a.cargo)}</div></div>
      <span class="status ${a.status}">${a.status === 'trabalhando' ? 'Trabalhando' : a.status === 'pausado' ? 'Pausado' : 'Online'}</span></div>
    <div class="now">${esc(a.atual)}</div>
    <div class="stats"><div><b>${a.nota ?? '—'}</b><span>desempenho</span></div><div><b>${a.acoes_24h}</b><span>ações 24h</span></div><div><b>${a.tarefas_abertas}</b><span>tarefas</span></div></div>
    <div class="actions">
      ${a.key !== 'atendente' ? `<button class="btn sm primary" data-run="${a.key}" ${a.enabled ? '' : 'disabled'}>Executar agora</button>` : `<a class="btn sm primary" href="#chat" style="text-align:center;text-decoration:none">Ver conversas</a>`}
      <a class="btn sm" href="#config/${a.key}" style="text-align:center;text-decoration:none">Configurar</a>
      <label class="switch" title="Ligar/desligar"><input type="checkbox" data-toggle="${a.key}" ${a.enabled ? 'checked' : ''}><span></span></label>
    </div></div>`;
}
async function renderTeam(soft = false) {
  const v = $('#view');
  if (!soft) v.innerHTML = '<div class="empty">Carregando equipe…</div>';
  const [data, feed] = await Promise.all([api('/team'), soft ? Promise.resolve(STATE.feed) : api('/activity?limit=60')]);
  if (currentTab() !== 'team') return;
  STATE.team = data; if (!soft) STATE.feed = feed;
  const g = data.team.find((a) => a.key === 'gerente'); const others = data.team.filter((a) => a.key !== 'gerente');
  const r = data.relatorio;
  v.innerHTML = `
    <div class="kpis">${data.kpis.items.map(kpiCard).join('')}</div>
    <div class="team-layout">
      <div>
        <div class="org"><div class="org-top">${agentCard(g)}</div><div class="org-lines"></div><div class="org-bottom">${others.map(agentCard).join('')}</div></div>
        ${r ? `<div class="card report"><div class="row"><h3 style="margin:0">📋 Último relatório do Gerente</h3><span class="spacer"></span><span class="muted">${ago(r.created_at)}</span></div>
          <p><b>${esc(r.titulo)}</b></p>
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
            <div><b>Destaques</b><ul>${(r.destaques || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
            <div><b>Riscos</b><ul>${(r.riscos || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div>
            <div><b>Próximas ações</b><ul>${(r.proximas_acoes || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
          </div></div>` : ''}
      </div>
      <div class="card"><div class="row"><h3 style="margin:0">Atividade em tempo real</h3><span class="spacer"></span><span class="live">ao vivo</span></div>
        <div class="feed" id="feed">${STATE.feed.map(feedItem).join('') || '<div class="empty">Nenhuma atividade ainda. Clique em “Executar agora” em um agente.</div>'}</div></div>
    </div>`;
  v.querySelectorAll('[data-run]').forEach((b) => (b.onclick = () => withBusy(b, async () => { await api(`/agents/${b.dataset.run}/run`, { method: 'POST', body: {} }); toast('Concluído!'); renderTeam(true); })));
  v.querySelectorAll('[data-toggle]').forEach((i) => (i.onchange = async () => { await api(`/agents/${i.dataset.toggle}/config`, { method: 'PUT', body: { enabled: i.checked } }); toast(i.checked ? 'Agente ligado' : 'Agente pausado'); renderTeam(true); }));
}

// ------------------------------------------------------------------ TAREFAS
async function renderTasks() {
  const tasks = await api('/tasks');
  const cols = [['todo', 'A fazer'], ['doing', 'Em andamento'], ['review', 'Aguardando você'], ['done', 'Concluídas']];
  const name = (k) => `${ICONS[k]} ${esc(AGENT_META[k]?.config?.nome_exibicao || k)}`;
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:16px"><form id="newTask" class="row">
      <select name="agent" style="width:auto">${Object.keys(AGENT_META).map((k) => `<option value="${k}">${name(k)} — ${esc(AGENT_META[k].nome)}</option>`).join('')}</select>
      <input name="title" placeholder="Ex.: Criar post sobre orquídeas para o Dia das Mães" required style="flex:1;min-width:220px">
      <select name="priority" style="width:auto"><option value="normal">Normal</option><option value="alta">Alta</option></select>
      <button class="btn primary">Delegar tarefa</button></form>
      <p class="muted" style="margin:8px 0 0">A Social Media e o Gestor de Tráfego pegam tarefas automaticamente. O Gerente também cria tarefas quando algo sai da meta.</p></div>
    <div class="kanban">${cols.map(([k, label]) => {
      const list = tasks.filter((t) => t.status === k).slice(0, k === 'done' ? 15 : 50);
      return `<div class="col"><h3>${label}<span>${tasks.filter((t) => t.status === k).length}</span></h3>${list.map((t) => `<div class="task">${esc(t.title)}
        <div class="meta"><span class="chip">${name(t.agent)}</span>${t.priority === 'alta' ? '<span class="chip alta">alta</span>' : ''}<span>por ${esc(t.created_by)}</span><span>${ago(t.created_at)}</span></div>
        ${k === 'review' ? `<div class="row" style="margin-top:8px"><button class="btn sm primary" data-approve="${t.id}">Aprovar</button><button class="btn sm" data-cancel="${t.id}">Recusar</button></div>` : ''}
        ${k === 'todo' ? `<div class="row" style="margin-top:8px"><button class="btn sm ghost" data-cancel="${t.id}">Cancelar</button></div>` : ''}
      </div>`).join('') || '<div class="empty">—</div>'}</div>`;
    }).join('')}</div>`;
  $('#newTask').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); await api('/tasks', { method: 'POST', body: Object.fromEntries(f) }); toast('Tarefa delegada'); renderTasks(); };
  document.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => withBusy(b, async () => { await api(`/tasks/${b.dataset.approve}/approve`, { method: 'POST' }); toast('Aprovado e executado'); renderTasks(); updateBadges(); })));
  document.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = async () => { await api(`/tasks/${b.dataset.cancel}`, { method: 'PATCH', body: { status: 'cancelled' } }); renderTasks(); updateBadges(); }));
}

// ------------------------------------------------------------------ CONTEÚDO
const POST_STATUS = { aguardando_aprovacao: 'Para aprovar', revisao_gerente: 'Com o Gerente', agendado: 'Agendados', publicado: 'Publicados', aprovado: 'Anúncios aprovados', descartado: 'Descartados', erro: 'Com erro' };
let postFilter = 'aguardando_aprovacao';
async function renderContent() {
  const posts = await api('/posts');
  const counts = posts.reduce((m, p) => ((m[p.status] = (m[p.status] || 0) + 1), m), {});
  const list = posts.filter((p) => postFilter === 'all' || p.status === postFilter);
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Conteúdo & Criativos</h2><span class="spacer"></span>
      <button class="btn primary" id="genWeek">🎨 Gerar conteúdo da semana</button></div>
    <div class="filters">${Object.entries(POST_STATUS).map(([k, l]) => `<button class="btn sm ${postFilter === k ? 'active' : ''}" data-f="${k}">${l} (${counts[k] || 0})</button>`).join('')}<button class="btn sm ${postFilter === 'all' ? 'active' : ''}" data-f="all">Todos</button></div>
    <div class="posts">${list.map(postCard).join('') || '<div class="empty card">Nenhuma peça aqui.</div>'}</div>`;
  document.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { postFilter = b.dataset.f; renderContent(); }));
  $('#genWeek').onclick = (e) => withBusy(e.target, async () => { await api('/agents/social/run', { method: 'POST', body: {} }); postFilter = 'all'; toast('Conteúdo criado!'); renderContent(); });
  document.querySelectorAll('[data-pa]').forEach((b) => (b.onclick = () => withBusy(b, async () => { await api(`/posts/${b.dataset.pa}/approve`, { method: 'POST', body: {} }); toast('Aprovado e agendado'); renderContent(); updateBadges(); })));
  document.querySelectorAll('[data-pn]').forEach((b) => (b.onclick = () => withBusy(b, async () => { await api(`/posts/${b.dataset.pn}/publish-now`, { method: 'POST' }); toast('Vai ao ar no próximo ciclo (até 1 min)'); renderContent(); })));
  document.querySelectorAll('[data-pr]').forEach((b) => (b.onclick = () => openModal(`<h3>Pedir ajuste</h3><label class="f">O que a Social Media deve mudar?<textarea name="fb" placeholder="Ex.: use um tom mais divertido e destaque a entrega grátis"></textarea></label>
    <div class="row"><button class="btn" value="discard">Descartar peça</button><span class="spacer"></span><button class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">Refazer</button></div>`,
    async (val, form) => { if (val === 'cancel') return; await api(`/posts/${b.dataset.pr}/reject`, { method: 'POST', body: val === 'discard' ? {} : { feedback: form.fb.value } }); toast(val === 'discard' ? 'Descartada' : 'Peça refeita'); renderContent(); updateBadges(); })));
}
function postCard(p) {
  const fmt = { feed: 'Feed', story: 'Story', anuncio: 'Anúncio' }[p.formato];
  const canApprove = ['aguardando_aprovacao', 'revisao_gerente', 'erro'].includes(p.status);
  return `<div class="card post"><div class="img"><img src="${esc(p.image_url)}" alt="${esc(p.titulo_arte)}" loading="lazy"></div>
    <div class="body"><div class="row"><span class="chip">${fmt}</span><span class="chip">${esc(POST_STATUS[p.status] || p.status)}</span>${p.revisao_gerente ? `<span class="chip" title="${esc(p.revisao_gerente.feedback)}">Gerente: ${p.revisao_gerente.nota}/10</span>` : ''}</div>
      <b>${esc(p.titulo_arte)}</b><div class="muted" style="font-size:12px">${p.formato === 'anuncio' ? 'Usado nas campanhas' : `📅 ${dt(p.scheduled_at)}`}</div>
      <div class="cap">${esc(p.legenda)}</div></div>
    <div class="actions">${canApprove ? `<button class="btn sm primary" data-pa="${p.id}">Aprovar</button>` : ''}
      ${p.status === 'agendado' ? `<button class="btn sm" data-pn="${p.id}">Publicar agora</button>` : ''}
      ${p.status !== 'publicado' && p.status !== 'descartado' ? `<button class="btn sm" data-pr="${p.id}">Ajustar</button>` : ''}
      <a class="btn sm ghost" href="${esc(p.image_url)}" download>Baixar</a></div></div>`;
}

// ------------------------------------------------------------------ ATENDIMENTO
let activeConv = null;
async function renderChat() {
  const convs = await api('/conversations');
  if (!activeConv && convs[0]) activeConv = convs[0].id;
  $('#view').innerHTML = `<div class="chat-layout">
    <div class="card conv-list"><div class="row" style="padding:6px"><h3 style="margin:0">Conversas</h3><span class="spacer"></span><button class="btn sm" id="newSim">+ Simular cliente</button></div>
      ${convs.map((c) => `<div class="conv ${c.id === activeConv ? 'active' : ''}" data-c="${c.id}"><div class="row"><b>${esc(c.contact_name || c.contact)}</b><span class="spacer"></span><span class="chip">${c.status === 'humano' ? '👤 humano' : '🤖 IA'}</span></div>
        <div class="last">${esc(c.ultima?.content || '')}</div><div class="muted" style="font-size:11px">${esc(c.channel)} · ${ago(c.updated_at)}${(c.pedidos || []).length ? ` · 🛒 ${c.pedidos.length} pedido(s)` : ''}${c.auditoria ? ` · nota ${c.auditoria.nota}` : ''}</div></div>`).join('') || '<div class="empty">Sem conversas. Simule um cliente para testar a Atendente.</div>'}</div>
    <div class="card chat" id="chatPane"></div></div>`;
  document.querySelectorAll('[data-c]').forEach((el) => (el.onclick = () => { activeConv = el.dataset.c; renderChat(); }));
  $('#newSim').onclick = () => { activeConv = 'new'; renderChatPane(); };
  renderChatPane();
}
async function renderChatPane() {
  const pane = $('#chatPane'); if (!pane) return;
  let conv = null; let msgs = [];
  if (activeConv && activeConv !== 'new') ({ conversation: conv, messages: msgs } = await api(`/conversations/${activeConv}/messages`));
  const simulavel = !conv || conv.channel === 'simulador';
  pane.innerHTML = `<div class="chat-head"><b>${esc(conv?.contact_name || conv?.contact || 'Novo cliente (simulador)')}</b><span class="muted">${esc(conv?.channel || 'simulador')}</span><span class="spacer"></span>
      ${conv ? `<button class="btn sm" id="mode">${conv.status === 'humano' ? 'Devolver para IA' : 'Assumir conversa'}</button>` : ''}</div>
    <div class="msgs" id="msgs">${msgs.map((m) => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join('') || '<div class="empty">Escreva como se fosse um cliente no WhatsApp. Ex.: “Quero flores para o aniversário da minha mãe, entrega no CEP 01310-100”</div>'}</div>
    ${simulavel ? `<form id="send"><input name="t" placeholder="Mensagem do cliente…" autocomplete="off" required><button class="btn primary">Enviar</button></form>` : '<div class="muted" style="padding:12px">Conversa real do WhatsApp — acompanhe em tempo real ou assuma o atendimento.</div>'}`;
  const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  if ($('#mode')) $('#mode').onclick = async () => { await api(`/conversations/${conv.id}/mode`, { method: 'POST', body: { mode: conv.status === 'humano' ? 'bot' : 'humano' } }); renderChat(); };
  if ($('#send')) $('#send').onsubmit = async (e) => {
    e.preventDefault(); const input = e.target.t; const text = input.value; input.value = '';
    box.insertAdjacentHTML('beforeend', `<div class="bubble user">${esc(text)}</div><div class="bubble assistant" id="typing">digitando…</div>`); box.scrollTop = box.scrollHeight;
    try {
      const contact = conv?.contact || `sim_${Date.now()}`;
      const r = await api('/chat', { method: 'POST', body: { text, contact, name: conv?.contact_name || 'Cliente teste' } });
      activeConv = r.conversation_id; renderChat();
    } catch (err) { $('#typing').textContent = err.message; }
  };
}

// ------------------------------------------------------------------ TRÁFEGO
async function renderAds() {
  const { campaigns, ultima_analise: a, demo } = await api('/campaigns');
  const n = (x, d = 2) => Number(x || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Campanhas ${demo ? '<span class="chip">demonstração</span>' : ''}</h2><span class="spacer"></span><button class="btn primary" id="runAds">📈 Analisar e otimizar agora</button></div>
    <div class="card table-wrap"><table><thead><tr><th>Campanha</th><th>Status</th><th class="num">Orç./dia</th><th class="num">Gasto 7d</th><th class="num">CTR</th><th class="num">Conv.</th><th class="num">CPA</th><th class="num">ROAS</th><th></th></tr></thead>
      <tbody>${campaigns.map((c) => `<tr><td>${esc(c.name)}${c.criada_pelo_agente ? ' <span class="chip">criada pela IA</span>' : ''}</td><td><span class="pill ${c.status}">${esc(c.status)}</span></td><td class="num">${brl(c.orcamento_diario)}</td><td class="num">${brl(c.gasto)}</td><td class="num">${n(c.ctr)}%</td><td class="num">${c.conversoes}</td><td class="num">${c.cpa ? brl(c.cpa) : '—'}</td><td class="num"><b>${n(c.roas)}x</b></td>
        <td>${c.status === 'ativa' ? `<button class="btn sm" data-pause="${esc(c.external_id)}">Pausar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Sem campanhas</td></tr>'}</tbody></table></div>
    ${a ? `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-top:16px">
      <div class="card"><h3>Diagnóstico do Gestor de Tráfego <span class="muted" style="font-weight:400">· ${ago(a.created_at)}</span></h3><p>${esc(a.diagnostico)}</p><b>Recomendações</b><ul>${(a.recomendacoes || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
      <div class="card"><h3>Ações automáticas</h3><ul>${(a.decisoes || []).map((d) => `<li><b>${esc(d.acao)}</b> ${esc(d.campanha)} — ${esc(d.motivo)}</li>`).join('') || '<li class="muted">Nenhuma ação necessária</li>'}</ul>
        <b>Novas campanhas propostas</b><ul>${(a.novas_campanhas || []).map((c) => `<li>${esc(c.nome)} (${brl(c.orcamento_diario)}/dia) — ${esc(c.justificativa)}</li>`).join('') || '<li class="muted">—</li>'}</ul></div></div>` : ''}`;
  $('#runAds').onclick = (e) => withBusy(e.target, async () => { await api('/agents/trafego/run', { method: 'POST', body: {} }); toast('Análise concluída'); renderAds(); });
  document.querySelectorAll('[data-pause]').forEach((b) => (b.onclick = () => withBusy(b, async () => { await api(`/campaigns/${encodeURIComponent(b.dataset.pause)}/pause`, { method: 'POST' }); renderAds(); })));
}

// ------------------------------------------------------------------ METAS (Gerente)
async function renderGoals() {
  const [cfg, kpis] = await Promise.all([api('/agents/gerente/config'), api('/kpis')]);
  const F = [['faturamento_mensal', 'Faturamento mensal (R$)'], ['pedidos_mes', 'Pedidos por mês'], ['ticket_medio', 'Ticket médio (R$)'], ['roas_minimo', 'ROAS mínimo do tráfego'], ['tempo_resposta_seg', 'Tempo máx. de resposta (seg)'], ['taxa_conversao_atendimento', 'Conversão no WhatsApp (%)'], ['posts_semana', 'Posts no feed por semana']];
  $('#view').innerHTML = `<h2>Metas da equipe</h2><div class="kpis">${kpis.items.map(kpiCard).join('')}</div>
    <form class="card" id="goalsForm"><fieldset><legend>🎯 Metas que o Gerente vai cobrar</legend><div class="form-grid">
      ${F.map(([k, l]) => `<label class="f">${l}<input type="number" step="any" name="${k}" value="${esc(cfg.metas[k])}"></label>`).join('')}</div></fieldset>
      <fieldset><legend>📋 O que o Gerente deve fazer</legend><div class="form-grid">
        <label class="f">Nível de exigência<select name="exigencia">${['baixa', 'media', 'alta'].map((x) => `<option ${cfg.exigencia === x ? 'selected' : ''} value="${x}">${x}</option>`).join('')}</select></label>
        <label class="f">Relatório<select name="frequencia">${['diario', 'semanal'].map((x) => `<option ${cfg.relatorio.frequencia === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f">Horário do relatório<input type="time" name="horario" value="${esc(cfg.relatorio.horario)}"></label>
        <label class="f">WhatsApp do dono (para relatório)<input name="whatsapp_dono" placeholder="5511999999999" value="${esc(cfg.relatorio.whatsapp_dono)}"></label>
        <label class="f row"><span class="switch"><input type="checkbox" name="revisar_posts_antes_de_publicar" ${cfg.revisar_posts_antes_de_publicar ? 'checked' : ''}><span></span></span> Revisar artes antes de publicar</label>
        <label class="f row"><span class="switch"><input type="checkbox" name="auditar_atendimentos" ${cfg.auditar_atendimentos ? 'checked' : ''}><span></span></span> Auditar atendimentos do WhatsApp</label>
      </div><label class="f" style="margin-top:12px">Instruções para o Gerente<textarea name="instrucoes">${esc(cfg.instrucoes)}</textarea></label></fieldset>
      <div class="row"><button class="btn primary">Salvar metas</button><button type="button" class="btn" id="runG">Gerar relatório agora</button></div></form>`;
  $('#goalsForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const metas = Object.fromEntries(F.map(([k]) => [k, Number(f[k].value)]));
    await api('/agents/gerente/config', { method: 'PUT', body: { metas, exigencia: f.exigencia.value, instrucoes: f.instrucoes.value, revisar_posts_antes_de_publicar: f.revisar_posts_antes_de_publicar.checked, auditar_atendimentos: f.auditar_atendimentos.checked, relatorio: { frequencia: f.frequencia.value, horario: f.horario.value, whatsapp_dono: f.whatsapp_dono.value } } });
    toast('Metas salvas'); renderGoals();
  };
  $('#runG').onclick = (e) => withBusy(e.target, async () => { await api('/agents/gerente/run', { method: 'POST', body: { sendReport: true } }); toast('Relatório gerado'); location.hash = 'team'; });
}

// ------------------------------------------------------------------ CONFIGURAR AGENTES
// Formulários gerados por schema: [campo, rótulo, tipo, ajuda]
const SCHEMAS = {
  atendente: [
    ['Identidade', [['nome_exibicao', 'Nome da atendente', 'text'], ['tom', 'Tom de voz', 'text'], ['saudacao', 'Saudação ({nome} = nome da atendente)', 'textarea']]],
    ['Horário', [['horario_atendimento.inicio', 'Abre às', 'time'], ['horario_atendimento.fim', 'Fecha às', 'time'], ['horario_atendimento.dias', 'Dias', 'days'], ['mensagem_fora_horario', 'Mensagem fora do horário', 'textarea']]],
    ['Vendas', [['fazer_upsell', 'Oferecer complementos (upsell)', 'bool'], ['sugestoes_upsell', 'Complementos sugeridos', 'list'], ['desconto_maximo_percent', 'Desconto máximo (%)', 'number'], ['politicas', 'Políticas (entrega, troca, pagamento)', 'textarea']]],
    ['Escalonamento', [['transferir_para_humano_quando', 'Transferir para humano quando', 'textarea'], ['whatsapp_humano', 'WhatsApp do atendente humano', 'text']]],
    ['Personalização', [['faq', 'Perguntas frequentes', 'faq'], ['instrucoes', 'Instruções extras', 'textarea']]],
  ],
  social: [
    ['Quantidades', [['posts_feed_semana', 'Posts de feed por semana', 'number'], ['stories_dia', 'Stories por dia', 'number'], ['criativos_anuncio_semana', 'Criativos de anúncio por semana', 'number']]],
    ['Agenda', [['dias', 'Dias de postagem', 'days'], ['horarios', 'Horários do feed', 'list', 'separe por vírgula, ex.: 10:00, 18:30']]],
    ['Marca', [['nome_exibicao', 'Nome da social media', 'text'], ['tom', 'Tom de voz', 'text'], ['cores_marca', 'Cores da marca (primária, secundária, fundo)', 'colors'], ['hashtags_fixas', 'Hashtags fixas', 'list'], ['temas', 'Temas preferidos', 'list']]],
    ['Publicação', [['publicacao_automatica', 'Publicar automaticamente (sem minha aprovação)', 'bool'], ['instrucoes', 'Instruções extras', 'textarea']]],
  ],
  trafego: [
    ['Verba e objetivo', [['nome_exibicao', 'Nome do gestor', 'text'], ['objetivo', 'Objetivo', 'select:vendas,mensagens,trafego'], ['verba_diaria', 'Verba diária (R$)', 'number'], ['verba_mensal', 'Verba mensal (R$)', 'number'], ['cpa_maximo', 'CPA máximo (R$)', 'number'], ['roas_minimo', 'ROAS mínimo', 'number']]],
    ['Público', [['cidade', 'Cidade', 'text'], ['raio_entrega_km', 'Raio de entrega (km)', 'number'], ['publico', 'Público-alvo', 'textarea']]],
    ['Regras automáticas', [['regras.pausar_sem_conversao_apos_gasto', 'Pausar se gastar (R$) sem conversão', 'number'], ['regras.pausar_ctr_abaixo', 'Pausar se CTR abaixo de (%)', 'number'], ['regras.escalar_roas_acima', 'Escalar se ROAS acima de', 'number'], ['regras.percentual_escala', 'Aumento ao escalar (%)', 'number'], ['frequencia_analise_horas', 'Analisar a cada (horas)', 'number']]],
    ['Autonomia', [['acao_automatica', 'Executar ações sozinho (senão, pede minha aprovação)', 'bool'], ['criar_campanhas_sazonais', 'Criar campanhas para datas comemorativas', 'bool'], ['instrucoes', 'Instruções extras', 'textarea']]],
  ],
  gerente: [
    ['Identidade', [['nome_exibicao', 'Nome do gerente', 'text'], ['exigencia', 'Exigência', 'select:baixa,media,alta'], ['amostra_auditoria', 'Conversas auditadas por ciclo', 'number'], ['instrucoes', 'Instruções', 'textarea']]],
  ],
};
const DAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); let x = o; ks.slice(0, -1).forEach((k) => (x = x[k] ??= {})); x[ks.at(-1)] = v; };
function field([k, label, type, help], cfg) {
  const v = getPath(cfg, k); const name = `f_${k}`;
  if (type === 'bool') return `<label class="f row"><span class="switch"><input type="checkbox" name="${name}" ${v ? 'checked' : ''}><span></span></span> ${label}</label>`;
  if (type === 'textarea') return `<label class="f" style="grid-column:1/-1">${label}<textarea name="${name}">${esc(v)}</textarea></label>`;
  if (type === 'list') return `<label class="f">${label}<input name="${name}" value="${esc((v || []).join(', '))}">${help ? `<small>${help}</small>` : ''}</label>`;
  if (type === 'days') return `<div class="f"><span style="font-size:13px;font-weight:500">${label}</span><div class="row">${DAYS.map((d) => `<label class="row" style="gap:3px"><input type="checkbox" style="width:auto" name="${name}" value="${d}" ${(v || []).includes(d) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>`;
  if (type === 'colors') return `<div class="f"><span style="font-size:13px;font-weight:500">${label}</span><div class="row">${[0, 1, 2].map((i) => `<input type="color" name="${name}" value="${esc(v?.[i] || '#ffffff')}" style="width:56px;height:36px;padding:2px">`).join('')}</div></div>`;
  if (type === 'faq') return `<label class="f" style="grid-column:1/-1">${label}<textarea name="${name}" style="min-height:110px" placeholder="Pergunta? | Resposta">${esc((v || []).map((x) => `${x.pergunta} | ${x.resposta}`).join('\n'))}</textarea><small>Uma por linha: pergunta | resposta</small></label>`;
  if (type.startsWith('select:')) return `<label class="f">${label}<select name="${name}">${type.slice(7).split(',').map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  return `<label class="f">${label}<input type="${type}" ${type === 'number' ? 'step="any"' : ''} name="${name}" value="${esc(v)}"></label>`;
}
function readField([k, , type], form, out) {
  const name = `f_${k}`;
  let v;
  if (type === 'bool') v = form.elements[name].checked;
  else if (type === 'list') v = form.elements[name].value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (type === 'days') v = [...form.querySelectorAll(`[name="${name}"]:checked`)].map((i) => i.value);
  else if (type === 'colors') v = [...form.querySelectorAll(`[name="${name}"]`)].map((i) => i.value);
  else if (type === 'faq') v = form.elements[name].value.split('\n').map((l) => l.split('|')).filter((p) => p[0]?.trim()).map(([p, r]) => ({ pergunta: p.trim(), resposta: (r || '').trim() }));
  else if (type === 'number') v = Number(form.elements[name].value);
  else v = form.elements[name].value;
  setPath(out, k, v);
}
async function renderConfig() {
  const sel = location.hash.split('/')[1] || 'atendente';
  const cfg = await api(`/agents/${sel}/config`);
  const meta = AGENT_META[sel];
  $('#view').innerHTML = `<div class="agent-tabs">${Object.keys(SCHEMAS).map((k) => `<a class="btn ${k === sel ? 'active' : ''}" style="--c:${AGENT_META[k].cor};text-decoration:none" href="#config/${k}">${ICONS[k]} ${esc(AGENT_META[k].nome)}</a>`).join('')}</div>
    <form class="card" id="cfgForm"><div class="row" style="margin-bottom:12px"><h2 style="margin:0">${ICONS[sel]} ${esc(meta.nome)}</h2><span class="muted">${esc(meta.descricao)}</span><span class="spacer"></span>
      <label class="row"><span class="switch"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}><span></span></span> Ativo</label></div>
      ${SCHEMAS[sel].map(([title, fields]) => `<fieldset><legend>${title}</legend><div class="form-grid">${fields.map((f) => field(f, cfg)).join('')}</div></fieldset>`).join('')}
      ${sel === 'gerente' ? '<p class="muted">As metas e rotinas do Gerente ficam na aba <a href="#goals">Metas</a>.</p>' : ''}
      <button class="btn primary">Salvar configurações</button></form>`;
  $('#cfgForm').onsubmit = async (e) => {
    e.preventDefault(); const out = { enabled: e.target.enabled.checked };
    SCHEMAS[sel].forEach(([, fields]) => fields.forEach((f) => readField(f, e.target, out)));
    await api(`/agents/${sel}/config`, { method: 'PUT', body: out }); toast('Configurações salvas');
    AGENT_META[sel].config = await api(`/agents/${sel}/config`);
  };
}

// ------------------------------------------------------------------ INTEGRAÇÕES
async function renderIntegrations() {
  const { tenant } = await api('/me');
  const base = location.origin;
  const I = tenant.integrations;
  const step = (n, key, title, desc, connected, fields, extra = '') => `<form class="card step" data-int="${key}">
    <div class="status-line"><span class="dot ${connected ? 'ok' : ''}"></span><b>${n}. ${title}</b><span class="spacer"></span><span class="muted">${connected ? 'Conectado' : 'Não conectado'}</span></div>
    <p class="muted" style="margin-top:0">${desc}</p><div class="grid" style="gap:10px">${fields.map(([k, l, val, ph]) => `<label class="f">${l}<input name="${k}" value="${esc(val || '')}" placeholder="${esc(ph || '')}"></label>`).join('')}</div>
    ${extra}<div class="row" style="margin-top:12px"><button class="btn primary">${connected ? 'Salvar e testar' : 'Conectar'}</button>${connected ? `<button type="button" class="btn ghost" data-disc="${key}">Desconectar</button>` : ''}</div></form>`;
  $('#view').innerHTML = `<h2>Conecte sua loja em 4 passos</h2>
    <div class="steps">
      ${step(1, 'iflores', 'Sistema iFlores', 'Catálogo, estoque, frete, pedidos e relatórios de vendas. Na iFlores: Configurações → API → Gerar token.', tenant.iflores.connected, [['base_url', 'URL da API', tenant.iflores.base_url, 'https://api.iflores.app.br'], ['token', 'Token da loja', tenant.iflores.token, 'cole o token aqui']])}
      ${step(2, 'whatsapp', 'WhatsApp Business', 'Número que a Atendente vai usar (WhatsApp Cloud API da Meta).', I.whatsapp.connected, [['phone_number_id', 'Phone Number ID', I.whatsapp.phone_number_id], ['access_token', 'Token de acesso', I.whatsapp.access_token]],
        `<p class="muted" style="font-size:12px">Webhook no app da Meta: <code>${esc(base)}/webhooks/whatsapp/${esc(tenant.id)}</code> · verify token: <code>WHATSAPP_VERIFY_TOKEN</code></p>`)}
      ${step(3, 'meta_ads', 'Meta Ads', 'Conta de anúncios que o Gestor de Tráfego vai gerenciar.', I.meta_ads.connected, [['ad_account_id', 'ID da conta de anúncios', I.meta_ads.ad_account_id, 'act_123456789'], ['access_token', 'Token de acesso (System User)', I.meta_ads.access_token]])}
      ${step(4, 'instagram', 'Instagram', 'Perfil comercial onde a Social Media publica.', I.instagram.connected, [['ig_user_id', 'Instagram Business ID', I.instagram.ig_user_id], ['access_token', 'Token de acesso', I.instagram.access_token]])}
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:16px">
      <div class="card"><h3>🔑 API aberta</h3><p class="muted">Use para integrar outros sistemas. Documentação: <a href="/docs/openapi.yaml" target="_blank">OpenAPI</a> · <a href="/docs/INTEGRACAO-IFLORES.md" target="_blank">Guia de integração</a></p>
        <p>Base URL: <code>${esc(base)}/api/v1</code></p><p>Chave atual: <code>${esc(tenant.api_key_prefix)}••••</code></p>
        <button class="btn" id="rotate">Gerar nova chave</button><div id="newKey"></div></div>
      <form class="card" id="hookForm"><h3>🔔 Webhook de eventos</h3><p class="muted">Receba os eventos dos agentes (pedido criado, conversa transferida, campanha pausada…) no seu sistema.</p>
        <label class="f">URL<input name="url" value="${esc(tenant.webhook.url)}" placeholder="https://sua-loja.iflores.app.br/hooks/agentes"></label>
        <label class="f row" style="margin-top:8px"><span class="switch"><input type="checkbox" name="enabled" ${tenant.webhook.enabled ? 'checked' : ''}><span></span></span> Ativo</label>
        <p class="muted" style="font-size:12px">Assinatura HMAC-SHA256 no header <code>X-IFlores-Signature</code> (segredo <code>${esc(tenant.webhook.secret)}</code>).</p>
        <button class="btn primary">Salvar webhook</button></form>
    </div>`;
  document.querySelectorAll('[data-int]').forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault(); const btn = $('button.primary', f);
    await withBusy(btn, async () => { const r = await api(`/integrations/${f.dataset.int}`, { method: 'PUT', body: Object.fromEntries(new FormData(f)) }); toast(r.test.ok ? 'Conectado com sucesso!' : `Falhou: ${r.test.error}`); });
    renderIntegrations();
  }));
  document.querySelectorAll('[data-disc]').forEach((b) => (b.onclick = async () => { await api(`/integrations/${b.dataset.disc}`, { method: 'DELETE' }); renderIntegrations(); }));
  $('#rotate').onclick = async () => { if (!confirm('A chave antiga deixará de funcionar. Continuar?')) return; const r = await api('/api-key/rotate', { method: 'POST' }); $('#newKey').innerHTML = `<p>Nova chave (copie agora, não será exibida de novo):<br><code>${esc(r.api_key)}</code></p>`; };
  $('#hookForm').onsubmit = async (e) => { e.preventDefault(); await api('/webhook', { method: 'PUT', body: { url: e.target.url.value, enabled: e.target.enabled.checked } }); toast('Webhook salvo'); };
}

// ------------------------------------------------------------------ modal
function openModal(html, onClose) {
  const d = $('#modal'); const f = $('#modalBody'); f.innerHTML = html;
  d.onclose = () => { onClose?.(d.returnValue, f); d.onclose = null; };
  d.returnValue = ''; d.showModal();
}

boot();
