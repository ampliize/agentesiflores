// Avisos do Alex e da equipe no canto inferior direito, o resumo de pipeline na aba Tarefas
// e o guia de configuração na aba Configurar. Usa só a API pública do painel (/api/v1).
// O token é capturado das próprias chamadas do painel, então funciona com a demonstração e com ?token=.
(() => {
  let token = null;
  const visto = new Set(JSON.parse(localStorage.getItem('eq_avisos_vistos') || '[]'));
  const salvarVistos = () => { try { localStorage.setItem('eq_avisos_vistos', JSON.stringify([...visto].slice(-300))); } catch { /* sem armazenamento: segue na sessão */ } };
  const secao = () => location.hash.replace('#', '').split('/')[0];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cor = { alex: '#4f46e5', flora: '#0f8a5f', mari: '#d6336c', caio: '#1c6dd0', sol: '#c77700' };
  const nome = { alex: 'Alex', flora: 'Flora', mari: 'Mari', caio: 'Caio', sol: 'Sol' };

  // 1. captura o token: qualquer chamada autenticada, ou a resposta da demonstração
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const auth = opts.headers?.authorization || opts.headers?.Authorization;
    if (url.includes('/api/v1/') && auth && auth.startsWith('Bearer ')) token = auth.slice(7);
    const res = await fetchOriginal(input, opts);
    if (url.endsWith('/api/v1/demo')) res.clone().json().then((j) => { if (j.token) { token = j.token; atualizar(); } }).catch(() => {});
    return res;
  };
  const api = async (caminho, metodo = 'GET') => {
    const r = await fetchOriginal(`/api/v1${caminho}`, { method: metodo, headers: { authorization: `Bearer ${token}` } });
    return r.json().catch(() => ({}));
  };

  // 2. pop-up de sugestões
  const caixa = document.createElement('div');
  caixa.id = 'avisos';
  caixa.setAttribute('role', 'region');
  caixa.setAttribute('aria-label', 'Sugestões da equipe');
  caixa.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:60;display:grid;gap:10px;width:min(360px,calc(100vw - 32px));pointer-events:none';
  document.body.appendChild(caixa);

  const cartao = (t) => {
    const c = cor[t.responsavel] || '#66756e';
    return `<div class="aviso" data-id="${esc(t.id)}" style="pointer-events:auto;background:var(--surface,#fff);color:var(--ink,#111);border:1px solid var(--line,#ddd);border-left:4px solid ${c};border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px 14px;display:grid;gap:8px;font:13px/1.45 system-ui,sans-serif">
      <div style="display:flex;gap:8px;align-items:center"><b style="color:${c}">${esc(nome[t.responsavel] || t.responsavel)}</b><span style="color:var(--muted,#66756e);font-size:11px">sugere</span><button data-dispensar style="margin-left:auto;border:0;background:none;color:var(--muted,#66756e);cursor:pointer;font-size:16px" aria-label="Fechar">×</button></div>
      <div style="font-weight:700">${esc(t.titulo)}</div>
      ${t.detalhes ? `<div style="color:var(--muted,#66756e);font-size:12px;white-space:pre-line">${esc(String(t.detalhes).slice(0, 220))}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-aprovar style="background:${c};color:#fff;border:0;border-radius:9px;padding:6px 10px;font-weight:700;cursor:pointer">Aprovar</button>
        <button data-recusar style="border:1px solid var(--line,#ddd);background:var(--surface,#fff);color:inherit;border-radius:9px;padding:6px 10px;cursor:pointer">Recusar</button>
        <button data-ver style="border:0;background:none;color:${c};font-weight:700;cursor:pointer;padding:6px 4px">Ver em Tarefas</button>
      </div>
    </div>`;
  };

  let pendentes = [];
  const desenhar = () => {
    const novas = pendentes.filter((t) => !visto.has(t.id)).slice(0, 3);
    caixa.innerHTML = novas.map(cartao).join('');
  };

  async function atualizar() {
    if (!token) return;
    const lista = await api('/tarefas?status=aguardando_dono');
    if (!Array.isArray(lista)) return;
    pendentes = lista.filter((t) => t.tipo !== 'acao');
    desenhar();
  }

  caixa.addEventListener('click', async (ev) => {
    const cartaoEl = ev.target.closest('.aviso'); if (!cartaoEl) return;
    const id = cartaoEl.dataset.id;
    const tarefa = pendentes.find((t) => t.id === id);
    if (ev.target.matches('[data-dispensar]')) { visto.add(id); salvarVistos(); desenhar(); return; }
    if (ev.target.matches('[data-ver]')) { location.hash = '#tarefas'; visto.add(id); salvarVistos(); desenhar(); return; }
    if (ev.target.matches('[data-aprovar],[data-recusar]')) {
      const acao = ev.target.matches('[data-aprovar]') ? 'aprovar' : 'recusar';
      ev.target.disabled = true;
      const r = await api(`/tarefas/${encodeURIComponent(id)}/${acao}`, 'POST');
      visto.add(id); salvarVistos();
      const msg = r.resultado || r.texto || (acao === 'aprovar' ? 'Feito.' : 'Recusada.');
      avisoRapido(`${tarefa?.titulo || 'Sugestão'}: ${msg}`);
      atualizar();
    }
  });

  function avisoRapido(texto) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:61;background:var(--ink,#111);color:var(--bg,#fff);padding:10px 14px;border-radius:12px;max-width:min(360px,calc(100vw - 32px));font:13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2)';
    t.textContent = texto;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  // 3. resumo do pipeline na aba Tarefas e guia na aba Configurar
  const guia = document.createElement('dialog');
  guia.id = 'guiaConfig';
  guia.style.cssText = 'border:0;border-radius:16px;padding:0;width:min(560px,94vw);background:var(--surface,#fff);color:var(--ink,#111);box-shadow:0 12px 40px rgba(0,0,0,.25)';
  guia.innerHTML = `<form method="dialog" style="padding:18px;display:grid;gap:12px">
    <h2 style="font-size:18px;margin:0">Onde configurar cada coisa</h2>
    <p style="margin:0;color:var(--muted,#66756e)">Tudo fica salvo na loja e vale de imediato para os agentes.</p>
    <ol style="margin:0;padding-left:18px;display:grid;gap:8px;font-size:13.5px">
      <li><b>Metas e relatório semanal</b> (Configurar › Alex): faturamento, pedidos e ticket que o Alex compara, e o dia do relatório.</li>
      <li><b>Resumo diário</b> (Configurar › Alex): horário e o WhatsApp do dono que recebe o resumo.</li>
      <li><b>Permissões</b> (Configurar › Alex): o que o Alex pode mudar sozinho (produtos, estoque, categorias, horários, datas, pedidos, data comemorativa, fretes). Se desligar uma área, ele pede a alteração em vez de fazê-la.</li>
      <li><b>Confirmação em lote</b> (Configurar › Alex): acima de quantos produtos ele pede confirmação antes de alterar.</li>
      <li><b>Instruções para o Alex</b> (Configurar › Alex): texto livre com o jeito de trabalhar da loja.</li>
      <li><b>Efeito das mudanças</b>: Loja (produtos, frete, datas e horários) e Finanças (custos, que a Sol usa para margem e preço).</li>
      <li><b>Sugestões</b>: aparecem aqui no canto da tela e na aba Tarefas, onde você aprova, recusa ou acompanha.</li>
    </ol>
    <div style="display:flex;justify-content:flex-end"><button style="border:1px solid var(--line,#ddd);background:var(--accent,#b8325e);color:var(--accent-ink,#fff);border-radius:9px;padding:7px 14px;font-weight:700;cursor:pointer">Entendi</button></div>
  </form>`;
  document.body.appendChild(guia);

  const resumoBox = document.createElement('div');
  resumoBox.id = 'pipeline';
  resumoBox.style.cssText = 'margin-bottom:14px';

  async function montarPipeline() {
    if (!token) return;
    const tarefas = await api('/tarefas');
    if (!Array.isArray(tarefas)) return;
    const conta = (f) => tarefas.filter(f).length;
    const semana = Date.now() - 7 * 864e5;
    const aprovadas = conta((t) => t.status === 'concluida' && t.tipo !== 'acao');
    const recusadas = conta((t) => t.status === 'recusada');
    const taxa = aprovadas + recusadas ? Math.round((aprovadas / (aprovadas + recusadas)) * 100) : null;
    const concluidas7 = conta((t) => t.status === 'concluida' && new Date(t.updated_at || t.created_at).getTime() > semana);
    const cartoes = [
      ['Aguardando você', conta((t) => t.status === 'aguardando_dono'), '#b45309'],
      ['Abertas', conta((t) => ['aberta', 'em_andamento'].includes(t.status)), '#1c6dd0'],
      ['Concluídas (7 dias)', concluidas7, '#17803d'],
      ['Aprovadas pelo dono', taxa === null ? '—' : `${taxa}%`, '#4f46e5'],
    ];
    resumoBox.innerHTML = `<div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">${cartoes.map(([l, v, c]) => `<div style="background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-top:3px solid ${c};border-radius:12px;padding:10px 12px"><div style="font-size:12px;color:var(--muted,#66756e)">${l}</div><div style="font-size:21px;font-weight:800">${v}</div></div>`).join('')}</div>
      <p style="margin:8px 0 0;font-size:12px;color:var(--muted,#66756e)">Pipeline: aguardando você → aberta → em andamento → concluída. "Aprovadas" é a taxa de sugestões que você aceitou sobre as que decidiu.</p>`;
  }

  function observar() {
    const view = document.getElementById('view'); if (!view) return;
    new MutationObserver(() => {
      const h = location.hash;
      if (secao() === 'tarefas' && view.querySelector('.kanban') && !document.getElementById('pipeline')) { view.prepend(resumoBox); montarPipeline(); }
      if (secao() === 'configurar' && !document.getElementById('btnGuia') && view.firstElementChild) {
        const b = document.createElement('button');
        b.id = 'btnGuia'; b.className = 'btn primary'; b.type = 'button';
        b.style.cssText = 'margin-bottom:14px';
        b.textContent = 'Onde configurar cada coisa';
        b.onclick = () => guia.showModal();
        view.prepend(b);
      }
    }).observe(view, { childList: true, subtree: false });
    window.addEventListener('hashchange', () => { if (secao() !== 'tarefas') resumoBox.remove(); });
  }

  // 4. atualização periódica dos avisos e do pipeline
  setInterval(() => { atualizar(); if (secao() === 'tarefas') montarPipeline(); }, 15000);
  observar();
})();
