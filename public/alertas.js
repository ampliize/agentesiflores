// Mensagens da equipe no canto inferior direito ("o Alex falando com você"), o resumo do pipeline
// na aba Tarefas e o guia de configuração na aba Configurar. Usa só a API pública (/api/v1).
// O token é capturado das próprias chamadas da página, então funciona na vitrine, no CRM e na demonstração.
(() => {
  let token = null;
  const ler = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento: vale só nesta sessão */ } };
  const visto = new Set(ler('eq_avisos_vistos', []));
  const salvarVistos = () => gravar('eq_avisos_vistos', [...visto].slice(-300));
  let minimizado = ler('eq_avisos_min', false);
  let indice = 0;
  const secao = () => location.hash.replace('#', '').split('/')[0];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cor = { alex: '#4f46e5', flora: '#0f8a5f', mari: '#d6336c', caio: '#1c6dd0', sol: '#c77700' };
  const nome = { alex: 'Alex', flora: 'Flora', mari: 'Mari', caio: 'Caio', sol: 'Sol' };
  const marca = 'var(--wine, var(--accent, #76213c))';

  // 1. captura o token: qualquer chamada autenticada, ou a resposta da demonstração
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const auth = opts.headers?.authorization || opts.headers?.Authorization;
    const novo = !token;
    if (url.includes('/api/v1/') && auth && auth.startsWith('Bearer ')) token = auth.slice(7);
    const res = await fetchOriginal(input, opts);
    if (url.endsWith('/api/v1/demo')) res.clone().json().then((j) => { if (j.token) { token = j.token; atualizar(); } }).catch(() => {});
    else if (novo && token) setTimeout(atualizar, 300);
    return res;
  };
  const api = async (caminho, metodo = 'GET') => {
    const r = await fetchOriginal(`/api/v1${caminho}`, { method: metodo, headers: { authorization: `Bearer ${token}` } });
    return r.json().catch(() => ({}));
  };

  // 2. a caixa de mensagem
  const estilo = document.createElement('style');
  estilo.textContent = `
  #avisos{position:fixed;right:18px;bottom:18px;z-index:60;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  #avisos .msg{width:min(340px,calc(100vw - 36px));background:var(--surface,#fffdf9);color:var(--ink,#302728);border:1px solid var(--line,#e9e2d9);border-radius:18px;box-shadow:0 14px 40px rgba(48,37,38,.22);overflow:hidden;animation:av-in .25s ease}
  #avisos .topo{display:flex;align-items:center;gap:10px;padding:12px 12px 8px 14px}
  #avisos .rosto{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800;flex:none}
  #avisos .quem{flex:1;min-width:0}#avisos .quem b{display:block}#avisos .quem small{color:var(--muted,#857878);font-size:11px}
  #avisos .icone{border:0;background:none;color:var(--muted,#857878);font-size:18px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:8px}
  #avisos .icone:hover{background:rgba(0,0,0,.05)}
  #avisos .fala{margin:0 14px;padding:12px 14px;background:var(--surface-2,#f5efe6);border-radius:4px 14px 14px 14px}
  #avisos .fala b{display:block;margin-bottom:4px}#avisos .fala p{margin:0;color:var(--muted,#6f6464);font-size:12.5px;white-space:pre-line}
  #avisos .acoes{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:12px 14px}
  #avisos .acoes button{border-radius:9px;padding:7px 12px;font-weight:600;font-size:12.5px;font-family:inherit;cursor:pointer}
  #avisos .sim{background:${marca};color:#fff;border:0}#avisos .nao{background:transparent;border:1px solid var(--line,#ddd);color:inherit}
  #avisos .ver{border:0;background:none;color:${marca};padding:7px 4px!important}
  #avisos .passos{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-top:1px solid var(--line,#eee);color:var(--muted,#857878);font-size:11.5px}
  #avisos .passos button{border:0;background:none;color:inherit;cursor:pointer;font-size:15px;padding:0 6px}
  #avisos .bolha{position:relative;width:58px;height:58px;border-radius:50%;border:0;color:#fff;font-weight:800;font-size:20px;font-family:inherit;cursor:pointer;box-shadow:0 10px 28px rgba(48,37,38,.3);animation:av-in .25s ease}
  #avisos .bolha .n{position:absolute;top:-4px;right:-4px;background:#fff;color:${marca};border-radius:99px;min-width:22px;height:22px;font-size:11px;display:grid;place-items:center;box-shadow:0 2px 6px rgba(0,0,0,.2)}
  #avisos .bolha.novo{animation:av-pulso 1.6s ease 3}
  @keyframes av-in{from{opacity:0;transform:translateY(8px)}}
  @keyframes av-pulso{50%{transform:scale(1.08)}}
  @media (prefers-reduced-motion:reduce){#avisos .msg,#avisos .bolha{animation:none!important}}`;
  document.head.appendChild(estilo);

  const caixa = document.createElement('div');
  caixa.id = 'avisos';
  caixa.setAttribute('role', 'region');
  caixa.setAttribute('aria-label', 'Mensagens da sua equipe');
  caixa.setAttribute('aria-live', 'polite');
  document.body.appendChild(caixa);

  let pendentes = [];
  let ultimoTotal = 0;
  const abertas = () => pendentes.filter((t) => !visto.has(t.id));

  function desenhar() {
    const lista = abertas();
    if (!lista.length) { caixa.innerHTML = ''; return; }
    if (indice >= lista.length) indice = 0;
    const t = lista[indice]; const quem = t.responsavel; const c = cor[quem] || '#857878';
    if (minimizado) {
      caixa.innerHTML = `<button class="bolha ${lista.length > ultimoTotal ? 'novo' : ''}" style="background:${c}" data-abrir aria-label="${lista.length} sugestão(ões) da equipe">${esc((nome[quem] || '?')[0])}<span class="n">${lista.length}</span></button>`;
      return;
    }
    const texto = String(t.recomendacao?.recomendacao || t.detalhes || '').slice(0, 260);
    caixa.innerHTML = `<div class="msg" data-id="${esc(t.id)}">
      <div class="topo"><span class="rosto" style="background:${c}">${esc((nome[quem] || '?')[0])}</span>
        <span class="quem"><b>${esc(nome[quem] || quem)}</b><small>${t.tipo === 'recomendacao' ? 'tem uma recomendação para você' : 'precisa da sua decisão'}</small></span>
        <button class="icone" data-min aria-label="Minimizar">–</button><button class="icone" data-fechar aria-label="Dispensar esta sugestão">×</button></div>
      <div class="fala"><b>${esc(t.titulo)}</b>${texto ? `<p>${esc(texto)}</p>` : ''}</div>
      <div class="acoes"><button class="sim" data-aprovar>${t.tipo === 'recomendacao' && !t.recomendacao?.autorizacao?.acao ? 'Marcar como feito' : 'Autorizar'}</button><button class="nao" data-recusar>Agora não</button><button class="ver" data-ver>Ver em Tarefas</button></div>
      ${lista.length > 1 ? `<div class="passos"><button data-ant aria-label="Sugestão anterior">‹</button><span>${indice + 1} de ${lista.length} sugestões</span><button data-prox aria-label="Próxima sugestão">›</button></div>` : ''}
    </div>`;
  }

  async function atualizar() {
    if (!token) return;
    const lista = await api('/tarefas?status=aguardando_dono');
    if (!Array.isArray(lista)) return;
    pendentes = lista.filter((t) => t.tipo !== 'acao');
    desenhar();
    ultimoTotal = abertas().length;
  }

  caixa.addEventListener('click', async (ev) => {
    const alvo = ev.target.closest('button'); if (!alvo) return;
    if (alvo.matches('[data-abrir]')) { minimizado = false; gravar('eq_avisos_min', false); desenhar(); return; }
    if (alvo.matches('[data-min]')) { minimizado = true; gravar('eq_avisos_min', true); ultimoTotal = abertas().length; desenhar(); return; }
    const lista = abertas(); const t = lista[indice]; if (!t) return;
    if (alvo.matches('[data-prox]')) { indice = (indice + 1) % lista.length; desenhar(); return; }
    if (alvo.matches('[data-ant]')) { indice = (indice - 1 + lista.length) % lista.length; desenhar(); return; }
    if (alvo.matches('[data-fechar]')) { visto.add(t.id); salvarVistos(); desenhar(); return; }
    if (alvo.matches('[data-ver]')) { if (document.getElementById('view')) location.hash = '#tarefas'; else location.href = '/painel/crm#tarefas'; return; }
    if (alvo.matches('[data-aprovar],[data-recusar]')) {
      const acao = alvo.matches('[data-aprovar]') ? 'aprovar' : 'recusar';
      alvo.disabled = true; alvo.textContent = acao === 'aprovar' ? 'Executando…' : 'Guardando…';
      const r = await api(`/tarefas/${encodeURIComponent(t.id)}/${acao}`, 'POST');
      visto.add(t.id); salvarVistos();
      avisoRapido(`${t.titulo}: ${r.resultado || r.texto || (acao === 'aprovar' ? 'feito.' : 'fica para depois.')}`);
      atualizar();
    }
  });

  function avisoRapido(texto) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:61;background:#302728;color:#fff;padding:12px 18px;border-radius:10px;max-width:min(520px,calc(100vw - 32px));font:13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2)';
    t.textContent = texto;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  // 3. resumo do pipeline na aba Tarefas e guia na aba Configurar (painel completo)
  const guia = document.createElement('dialog');
  guia.id = 'guiaConfig';
  guia.style.cssText = 'border:0;border-radius:16px;padding:0;width:min(560px,94vw);background:var(--surface,#fff);color:var(--ink,#111);box-shadow:0 12px 40px rgba(0,0,0,.25)';
  guia.innerHTML = `<form method="dialog" style="padding:18px;display:grid;gap:12px">
    <h2 style="font-size:18px;margin:0">Onde configurar cada coisa</h2>
    <p style="margin:0;color:var(--muted,#66756e)">Tudo fica salvo na loja e vale de imediato para os agentes.</p>
    <ol style="margin:0;padding-left:18px;display:grid;gap:8px;font-size:13.5px">
      <li><b>Metas</b> (Configurar › Alex): faturamento, pedidos e ticket que o Alex usa como referência.</li>
      <li><b>Rotina</b> (Configurar › Alex): horário do resumo diário e o WhatsApp do dono que recebe o resumo.</li>
      <li><b>Permissões</b> (Configurar › Alex): o que o Alex pode mudar sozinho (produtos, estoque, categorias e destaques, horários, pedidos, catálogo comemorativo, fretes).</li>
      <li><b>Confirmação em lote</b> (Configurar › Alex): acima de quantos produtos ele pede confirmação antes de alterar.</li>
      <li><b>Compras</b> (Configurar › Alex): dias de cobertura, perda padrão e multiplicador em datas fortes.</li>
      <li><b>Instruções para o Alex</b> (Configurar › Alex): texto livre com o jeito de trabalhar da loja.</li>
      <li><b>Efeito das mudanças</b>: Loja (produtos, frete, datas e horários) e Finanças (custos que a Sol usa para margem e preço).</li>
      <li><b>Sugestões</b>: chegam como mensagem no canto da tela e ficam em Tarefas, onde você autoriza, recusa ou acompanha.</li>
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

  // 4. atualização periódica das mensagens e do pipeline
  setInterval(() => { if (!document.hidden) { atualizar(); if (secao() === 'tarefas') montarPipeline(); } }, 15000);
  observar();
})();
