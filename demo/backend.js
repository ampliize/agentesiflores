// Backend simulado da demo no navegador. Intercepta fetch('/api/v1/...') e EventSource,
// reproduzindo o comportamento do servidor em modo demonstração (sem IA, dados de exemplo).
// `renderArtSvg` é injetado pelo script de build (src/lib/art-svg.js).
(() => {
  const uid = (p) => p + Math.random().toString(36).slice(2, 11);
  const now = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const fmt = (n) => Number(n || 0).toFixed(2).replace('.', ',');
  const listeners = new Set();
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  let FAST = false; // carga inicial sem esperas

  const AGENTS = {
    gerente: { nome: 'Gerente', cargo: 'Gerente da Equipe Virtual', avatar: '👩‍💼', cor: '#7c3aed', descricao: 'Acompanha metas, revisa o trabalho dos outros agentes e reporta ao dono.' },
    trafego: { nome: 'Gestor de Tráfego', cargo: 'Especialista em Tráfego Pago', avatar: '📈', cor: '#2563eb', descricao: 'Cria, analisa e otimiza campanhas. Pausa o que não performa e escala o que vende.' },
    social: { nome: 'Social Media', cargo: 'Designer & Social Media', avatar: '🎨', cor: '#db2777', descricao: 'Cria artes de feed, stories e anúncios e publica automaticamente.' },
    atendente: { nome: 'Atendente', cargo: 'Vendedora no WhatsApp', avatar: '💬', cor: '#16a34a', descricao: 'Atende clientes, tira dúvidas, calcula frete e fecha pedidos pelo WhatsApp.' },
  };
  const KEYS = Object.keys(AGENTS);
  const CFG = {
    gerente: { enabled: true, nome_exibicao: 'Flora', metas: { faturamento_mensal: 30000, pedidos_mes: 250, ticket_medio: 150, roas_minimo: 4, tempo_resposta_seg: 60, taxa_conversao_atendimento: 25, posts_semana: 5 }, relatorio: { frequencia: 'diario', horario: '19:00', canal: 'whatsapp', whatsapp_dono: '' }, exigencia: 'alta', revisar_posts_antes_de_publicar: true, auditar_atendimentos: true, amostra_auditoria: 5, instrucoes: 'Priorize vendas para datas comemorativas e garanta que nenhuma conversa fique sem resposta.' },
    trafego: { enabled: true, nome_exibicao: 'Leo', plataforma: 'meta', objetivo: 'vendas', verba_diaria: 80, verba_mensal: 2400, cpa_maximo: 35, roas_minimo: 3, raio_entrega_km: 15, cidade: 'São Paulo', publico: 'Mulheres e homens 25-55, interesses: flores, presentes, decoração, datas especiais', regras: { pausar_sem_conversao_apos_gasto: 60, pausar_ctr_abaixo: 0.8, escalar_roas_acima: 5, percentual_escala: 20 }, acao_automatica: true, criar_campanhas_sazonais: true, frequencia_analise_horas: 6, instrucoes: '' },
    social: { enabled: true, nome_exibicao: 'Bia', posts_feed_semana: 4, stories_dia: 2, criativos_anuncio_semana: 2, horarios: ['10:00', '18:30'], dias: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'], tom: 'acolhedor, romântico e elegante', hashtags_fixas: ['#floricultura', '#flores', '#presente'], cores_marca: ['#c2185b', '#1b5e20', '#fff7f2'], publicacao_automatica: false, usar_fotos_produtos: true, temas: ['produtos em destaque', 'bastidores', 'dicas de cuidado', 'datas comemorativas', 'depoimentos'], instrucoes: '' },
    atendente: { enabled: true, nome_exibicao: 'Rosa', saudacao: 'Olá! 🌷 Seja bem-vindo(a)! Sou a {nome}, como posso deixar seu dia mais florido?', tom: 'simpática, próxima e objetiva; usa emojis com moderação', horario_atendimento: { inicio: '08:00', fim: '20:00', dias: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'] }, mensagem_fora_horario: 'Estamos fora do horário agora, mas já anotei seu pedido e retornamos assim que abrirmos! 🌸', fazer_upsell: true, sugestoes_upsell: ['cartão personalizado', 'chocolate', 'pelúcia', 'vaso decorativo'], desconto_maximo_percent: 5, politicas: 'Entregas no mesmo dia para pedidos até 15h. Trocas em até 24h mediante foto. Pagamento via Pix, cartão ou link.', transferir_para_humano_quando: 'reclamação, pedido de desconto acima do permitido, eventos/casamentos, cliente pedir atendente humano', whatsapp_humano: '', faq: [{ pergunta: 'Vocês entregam hoje?', resposta: 'Sim! Pedidos confirmados até 15h saem no mesmo dia.' }], instrucoes: '' },
  };
  const PRODUCTS = [
    { id: 'p1', nome: 'Buquê 12 Rosas Vermelhas', preco: 189.9, categoria: 'buques', descricao: 'Clássico buquê com 12 rosas colombianas vermelhas, folhagens e papel kraft.', tags: ['romantico', 'namorados', 'aniversario'] },
    { id: 'p2', nome: 'Arranjo Girassóis Alegria', preco: 149.9, categoria: 'arranjos', descricao: '6 girassóis em vaso de vidro com laço amarelo.', tags: ['alegria', 'amizade', 'melhoras'] },
    { id: 'p3', nome: 'Orquídea Phalaenopsis Branca', preco: 129.9, categoria: 'plantas', descricao: 'Orquídea com 2 hastes em cachepô de cerâmica.', tags: ['elegante', 'maes', 'corporativo'] },
    { id: 'p4', nome: 'Cesta Café da Manhã com Flores', preco: 259.9, categoria: 'cestas', descricao: 'Cesta com mini buquê, pães, frutas, suco e chocolates.', tags: ['maes', 'aniversario', 'surpresa'] },
    { id: 'p5', nome: 'Box Rosas & Ferrero', preco: 219.9, categoria: 'presentes', descricao: 'Caixa com 9 rosas e 8 bombons Ferrero Rocher.', tags: ['romantico', 'namorados'] },
    { id: 'p6', nome: 'Mini Buquê Campestre', preco: 79.9, categoria: 'buques', descricao: 'Flores do campo sortidas, ideal para um carinho rápido.', tags: ['carinho', 'economico'] },
  ];
  const S = {
    tenant: { id: 'loja_demo', name: 'Floricultura Jardim Encantado', plan: 'completo', status: 'active', api_key_prefix: 'ifa_dEm0Xy', brand: { primary: '#c2185b' },
      iflores: { base_url: '', token: '', connected: false },
      integrations: { whatsapp: { connected: false, phone_number_id: '', access_token: '' }, meta_ads: { connected: false, ad_account_id: '', access_token: '' }, instagram: { connected: false, ig_user_id: '', access_token: '' } },
      webhook: { url: '', secret: 'whs_••••demo', enabled: false } },
    activity: [], tasks: [], posts: [], convs: [], msgs: {}, reports: [], status: {},
    campaigns: [
      ['Rosas - Conversão Site', 40, 212, 9100, 182, 2.0, 9, 1710], ['Remarketing Carrinho', 20, 98, 4100, 131, 3.2, 6, 1140],
      ['Girassóis - Alcance Bairros', 25, 118, 15200, 91, 0.6, 0, 0], ['WhatsApp - Mensagens', 30, 151, 7800, 160, 2.05, 5, 820],
    ].map(([name, b, g, imp, cl, ctr, conv, rec]) => ({ external_id: uid('c_'), name, status: 'ativa', orcamento_diario: b, gasto: g, impressoes: imp, cliques: cl, ctr, conversoes: conv, receita: rec, roas: rec / g, cpa: conv ? g / conv : null })),
  };

  function log(agent, type, message, level = 'info', data = {}) {
    const item = { id: uid('act_'), agent, type, level, message, data, created_at: now() };
    S.activity.unshift(item); emit({ kind: 'activity', item });
  }
  async function working(agent, current, fn) {
    emit({ kind: 'status', agent, status: 'trabalhando', current }); S.status[agent] = current;
    if (!FAST) await sleep(700 + Math.random() * 600);
    try { return await fn(); } finally { emit({ kind: 'status', agent, status: 'online', current: '' }); S.status[agent] = ''; }
  }
  function createTask({ agent, title, priority = 'normal', created_by = 'dono', status = 'todo', ...data }) {
    const dup = S.tasks.find((t) => t.agent === agent && t.title === title && ['todo', 'doing', 'review'].includes(t.status));
    if (dup) return dup;
    const t = { id: uid('task_'), agent, title, priority, created_by, status, created_at: now(), updated_at: now(), ...data };
    S.tasks.unshift(t); log(created_by === 'dono' ? agent : created_by, 'tarefa_criada', `Nova tarefa para ${agent}: ${title}`);
    return t;
  }

  // ---------- Social ----------
  const artUrl = (p) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderArtSvg({ formato: p.formato, titulo: p.titulo_arte, subtitulo: p.subtitulo_arte, cta: p.cta, preco: p.mostrar_preco && p.produto ? brl(p.produto.preco) : '', loja: S.tenant.name, cores: CFG.social.cores_marca, layout: p.layout }));
  function slot(i, hours) { const d = new Date(); d.setDate(d.getDate() + 1 + Math.floor(i / hours.length)); const [h, m] = hours[i % hours.length].split(':'); d.setHours(+h, +m, 0, 0); return d.toISOString(); }
  function createPost(p) {
    const g = CFG.gerente;
    const status = g.enabled && g.revisar_posts_antes_de_publicar ? 'revisao_gerente' : CFG.social.publicacao_automatica ? 'agendado' : 'aguardando_aprovacao';
    const post = { id: uid('post_'), status, revisoes: [], created_at: now(), ...p }; post.image_url = artUrl(post);
    S.posts.unshift(post); return post;
  }
  async function planWeek(reason = 'execução manual') {
    const c = CFG.social; const tag = c.hashtags_fixas; const pick = (i) => PRODUCTS[i % PRODUCTS.length];
    return working('social', 'Planejando conteúdo da semana', () => {
      const out = [];
      for (let i = 0; i < c.posts_feed_semana; i++) {
        const p = pick(i); const isDate = i === 0;
        out.push(createPost({ formato: 'feed', tema: isDate ? 'Natal' : c.temas[i % c.temas.length], produto: p, titulo_arte: isDate ? 'Natal florido' : p.nome.replace(/\s*&.*$/, ''), subtitulo_arte: isDate ? `Garanta já o presente perfeito: ${p.nome}` : p.descricao.split('.')[0], cta: 'Peça pelo WhatsApp', mostrar_preco: i % 2 === 0, legenda: `${isDate ? '🎄 O Natal está chegando!' : `✨ ${p.nome}`}\n\n${p.descricao}\n\nEntrega no mesmo dia para pedidos até 15h. Chame no WhatsApp! 💌`, hashtags: [...tag, '#' + p.categoria], layout: ['classico', 'destaque', 'minimal'][i % 3], scheduled_at: slot(i, c.horarios) }));
      }
      for (let i = 0; i < Math.min(c.stories_dia * 3, 6); i++) {
        const p = pick(i + 2);
        out.push(createPost({ formato: 'story', tema: 'produto do dia', produto: p, titulo_arte: i % 2 ? 'Peça hoje, receba hoje' : p.nome.replace(/\s*&.*$/, ''), subtitulo_arte: 'Toque para chamar no WhatsApp', cta: 'Arrasta pra cima', mostrar_preco: i % 2 === 0, legenda: p.nome, hashtags: tag, layout: i % 2 ? 'destaque' : 'classico', scheduled_at: slot(i, ['09:00', '12:30', '17:00']) }));
      }
      for (let i = 0; i < c.criativos_anuncio_semana; i++) {
        const p = pick(i);
        out.push(createPost({ formato: 'anuncio', tema: 'conversão', produto: p, titulo_arte: i ? 'Surpreenda hoje' : 'Flores que emocionam', subtitulo_arte: `${p.nome} com entrega no mesmo dia`, cta: 'Compre agora', mostrar_preco: true, legenda: `${p.nome} por ${brl(p.preco)}. Entrega hoje!`, hashtags: [], layout: 'destaque', scheduled_at: null }));
      }
      log('social', 'plano_criado', `Criou ${out.length} peças (${reason})`, 'success');
      return out;
    });
  }
  function revise(post, feedback, by) {
    post.layout = post.layout === 'destaque' ? 'classico' : 'destaque';
    if (/whats/i.test(feedback)) post.legenda += '\n\n👉 Chame agora no WhatsApp e garanta o seu!';
    post.revisoes.push({ por: by, feedback, em: now() }); post.image_url = artUrl(post);
    post.status = CFG.social.publicacao_automatica ? 'agendado' : 'aguardando_aprovacao';
    log('social', 'post_revisado', `Revisou a peça "${post.titulo_arte}" após feedback do ${by}`);
  }

  // ---------- Tráfego ----------
  function rules() {
    const c = CFG.trafego; const r = c.regras; const out = [];
    for (const k of S.campaigns.filter((x) => x.status === 'ativa')) {
      if (k.gasto >= r.pausar_sem_conversao_apos_gasto && !k.conversoes) out.push({ acao: 'pausar', campanha: k, motivo: `Gastou R$ ${fmt(k.gasto)} sem nenhuma conversão (limite R$ ${r.pausar_sem_conversao_apos_gasto})` });
      else if (k.impressoes > 2000 && k.ctr < r.pausar_ctr_abaixo) out.push({ acao: 'pausar', campanha: k, motivo: `CTR ${fmt(k.ctr)}% abaixo do mínimo de ${r.pausar_ctr_abaixo}%` });
      else if (k.cpa && k.cpa > c.cpa_maximo * 1.3) out.push({ acao: 'pausar', campanha: k, motivo: `CPA R$ ${fmt(k.cpa)} acima do máximo` });
      else if (k.roas >= r.escalar_roas_acima) { const novo = Math.round(k.orcamento_diario * (1 + r.percentual_escala / 100)); out.push({ acao: 'escalar', campanha: k, novo_orcamento: novo, motivo: `ROAS ${fmt(k.roas)} acima de ${r.escalar_roas_acima}: orçamento R$ ${k.orcamento_diario} → R$ ${novo}` }); }
    }
    return out;
  }
  function apply(d) {
    if (d.acao === 'pausar') { d.campanha.status = 'pausada'; log('trafego', 'campanha_pausada', `Pausou "${d.campanha.name}": ${d.motivo}`, 'warning'); }
    if (d.acao === 'escalar') { d.campanha.orcamento_diario = d.novo_orcamento; log('trafego', 'campanha_escalada', `Escalou "${d.campanha.name}": ${d.motivo}`, 'success'); }
  }
  async function analyze(reason = 'execução manual') {
    return working('trafego', 'Analisando campanhas', () => {
      const c = CFG.trafego; const dec = rules();
      for (const d of dec) {
        if (c.acao_automatica) apply(d);
        else createTask({ agent: 'trafego', title: `Aprovar: ${d.acao} "${d.campanha.name}" — ${d.motivo}`, created_by: 'trafego', status: 'review', priority: 'alta', decision: { acao: d.acao, external_id: d.campanha.external_id, novo_orcamento: d.novo_orcamento, motivo: d.motivo } });
      }
      const g = S.campaigns.reduce((s, k) => s + k.gasto, 0); const rec = S.campaigns.reduce((s, k) => s + k.receita, 0);
      const novas = c.criar_campanhas_sazonais && !S.campaigns.some((k) => k.name.startsWith('Natal')) ? [{ nome: 'Natal - Conversão', objetivo: 'OUTCOME_SALES', orcamento_diario: Math.round(c.verba_diaria * 0.3), justificativa: 'Natal é uma das datas de maior volume para floriculturas; começar 15 dias antes.', mensagem: 'Presenteie com flores no Natal, entrega garantida' }] : [];
      for (const n of novas) {
        if (c.acao_automatica) { S.campaigns.push({ external_id: uid('c_'), name: n.nome, status: 'pausada', orcamento_diario: n.orcamento_diario, gasto: 0, impressoes: 0, cliques: 0, ctr: 0, conversoes: 0, receita: 0, roas: 0, cpa: null, criada_pelo_agente: true }); log('trafego', 'campanha_criada', `Criou campanha "${n.nome}" (R$ ${n.orcamento_diario}/dia, pausada até o criativo ficar pronto)`, 'success'); createTask({ agent: 'social', title: `Criativos para campanha "${n.nome}": ${n.mensagem}`, created_by: 'trafego', priority: 'alta' }); }
        else createTask({ agent: 'trafego', title: `Aprovar nova campanha "${n.nome}" (R$ ${n.orcamento_diario}/dia)`, created_by: 'trafego', status: 'review', proposta: n });
      }
      const rep = { id: uid('rep_'), created_at: now(), campanhas: S.campaigns.length, decisoes: dec.map((d) => ({ acao: d.acao, campanha: d.campanha.name, motivo: d.motivo })), diagnostico: `ROAS geral de ${fmt(g ? rec / g : 0)} em 7 dias (meta ${c.roas_minimo}). ${dec.filter((d) => d.acao === 'pausar').length} campanha(s) cortada(s) por baixo desempenho.`, recomendacoes: ['Concentrar verba nas campanhas de conversão com ROAS acima da meta.', 'Testar 2 novos criativos em vídeo curto mostrando a montagem do buquê.', `Segmentar por raio de ${c.raio_entrega_km} km da loja para não pagar por cliques fora da área de entrega.`], novas_campanhas: novas };
      S.reports.unshift({ agent: 'trafego', ...rep });
      log('trafego', 'analise', `Análise concluída (${reason}): ${rep.diagnostico}`, 'success');
      return rep;
    });
  }

  // ---------- Atendente ----------
  async function chat({ contact, name, text }) {
    let conv = S.convs.find((c) => c.contact === contact);
    if (!conv) { conv = { id: uid('conv_'), channel: 'simulador', contact, contact_name: name, status: 'bot', pedidos: [], created_at: now(), updated_at: now() }; S.convs.unshift(conv); S.msgs[conv.id] = []; }
    const msgs = S.msgs[conv.id]; msgs.push({ role: 'user', content: text, created_at: now() }); conv.updated_at = now();
    if (!CFG.atendente.enabled || conv.status === 'humano') return { conversation_id: conv.id, reply: null };
    const c = CFG.atendente;
    const reply = await working('atendente', `Atendendo ${name || contact}`, () => {
      const t = text.toLowerCase(); const first = !msgs.some((m) => m.role === 'assistant');
      const hello = first ? c.saudacao.replace('{nome}', c.nome_exibicao) + '\n\n' : '';
      if (/humano|atendente|pessoa|reclama/.test(t)) { conv.status = 'humano'; log('atendente', 'transferido_humano', `Conversa com ${name} transferida para humano`, 'warning'); return 'Claro! Já chamei alguém da nossa equipe, só um instante 🙏'; }
      const cep = t.match(/\d{5}-?\d{3}/);
      if (cep) { const fee = 12 + (Number(cep[0].slice(-2)) % 4) * 5; return `${hello}Entregamos sim no CEP ${cep[0]}! 🚚 Taxa de ${brl(fee)}, mesmo dia (pedidos até 15h). Janelas: 09h-12h, 12h-15h, 15h-18h. Qual prefere?`; }
      if (/janela|manh|tarde|\d{1,2}h/.test(t) && !first) {
        const p = PRODUCTS[0]; const id = 'PED' + Math.floor(Math.random() * 90000 + 10000);
        conv.pedidos.push(id); log('atendente', 'pedido_criado', `Pedido ${id} criado para ${name} (${brl(p.preco + 12)})`, 'success');
        return `Pedido ${id} criado! 💐\n${p.nome} + entrega: ${brl(p.preco + 12)}\nPague por aqui: https://pagar.iflores.app.br/demo/${id}\n\nAssim que o pagamento cair, já começamos a montar!`;
      }
      if (/quero|fechar|comprar|esse|pode ser|gostei/.test(t) && !first) return 'Perfeito! 💐 Para finalizar me envia: nome de quem vai receber, endereço com CEP, data da entrega e a mensagem do cartão.' + (c.fazer_upsell ? `\n\nQuer incluir um ${c.sugestoes_upsell[0]}? Fica lindo junto!` : '');
      const norm = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      const terms = norm(t).split(/\s+/).filter((w) => w.length > 3);
      let items = PRODUCTS.filter((p) => terms.some((w) => norm(`${p.nome} ${p.descricao} ${p.tags.join(' ')}`).includes(w)));
      if (!items.length) items = PRODUCTS;
      return `${hello}Separei algumas opções lindas pra você:\n${items.slice(0, 3).map((p) => `• ${p.nome} — ${brl(p.preco)}`).join('\n')}\n\nQual delas mais combina com a ocasião?`;
    });
    msgs.push({ role: 'assistant', content: reply, created_at: now() }); conv.updated_at = now();
    conv.respostas = (conv.respostas || 0) + 1; conv.tempo = (conv.tempo || 0) + 2;
    log('atendente', 'mensagem', `Respondeu ${name}: "${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}"`);
    return { conversation_id: conv.id, reply };
  }

  // ---------- Gerente ----------
  function kpis() {
    const m = CFG.gerente.metas; const d = new Date(); const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); const el = d.getDate();
    const pedidos = Math.round(el * 7.4) + S.convs.reduce((s, c) => s + c.pedidos.length, 0); const fat = pedidos * 163.5; const proj = (fat / el) * dim;
    const g = S.campaigns.reduce((s, k) => s + k.gasto, 0); const rec = S.campaigns.reduce((s, k) => s + k.receita, 0); const roas = g ? rec / g : 0;
    const conv = S.convs.length ? Math.round((S.convs.filter((c) => c.pedidos.length).length / S.convs.length) * 1000) / 10 : 0;
    const resp = S.convs.reduce((s, c) => s + (c.respostas || 0), 0); const tempo = resp ? Math.round(S.convs.reduce((s, c) => s + (c.tempo || 0), 0) / resp) : 0;
    const posts = S.posts.filter((p) => p.formato === 'feed' && ['agendado', 'publicado'].includes(p.status)).length;
    const pct = (v, t) => (t ? Math.min(999, Math.round((v / t) * 100)) : 0);
    return { items: [
      { chave: 'faturamento_mensal', label: 'Faturamento do mês', valor: fat, meta: m.faturamento_mensal, fmt: 'brl', projecao: proj, progresso: pct(proj, m.faturamento_mensal) },
      { chave: 'pedidos_mes', label: 'Pedidos no mês', valor: pedidos, meta: m.pedidos_mes, fmt: 'int', progresso: pct((pedidos / el) * dim, m.pedidos_mes) },
      { chave: 'ticket_medio', label: 'Ticket médio', valor: 163.5, meta: m.ticket_medio, fmt: 'brl', progresso: pct(163.5, m.ticket_medio) },
      { chave: 'roas_minimo', label: 'ROAS (7 dias)', valor: Math.round(roas * 100) / 100, meta: m.roas_minimo, fmt: 'x', progresso: pct(roas, m.roas_minimo), agente: 'trafego' },
      { chave: 'tempo_resposta_seg', label: 'Tempo médio de resposta', valor: tempo, meta: m.tempo_resposta_seg, fmt: 'seg', progresso: tempo ? pct(m.tempo_resposta_seg, tempo) : 100, agente: 'atendente', menor_melhor: true },
      { chave: 'taxa_conversao_atendimento', label: 'Conversão no WhatsApp', valor: conv, meta: m.taxa_conversao_atendimento, fmt: '%', progresso: pct(conv, m.taxa_conversao_atendimento), agente: 'atendente' },
      { chave: 'posts_semana', label: 'Posts no feed (7 dias)', valor: posts, meta: m.posts_semana, fmt: 'int', progresso: pct(posts, m.posts_semana), agente: 'social' },
    ] };
  }
  async function supervise() {
    return working('gerente', 'Supervisionando a equipe', async () => {
      const g = CFG.gerente;
      if (g.revisar_posts_antes_de_publicar) for (const p of S.posts.filter((x) => x.status === 'revisao_gerente')) {
        const ok = p.formato !== 'story' || p.revisoes.length > 0 || Math.random() > 0.4;
        const r = { aprovado: ok, nota: ok ? 8 : 5, feedback: ok ? 'Peça clara e com CTA.' : 'Legenda curta demais; reforce a chamada para o WhatsApp.' };
        p.revisao_gerente = r;
        if (ok) { p.status = CFG.social.publicacao_automatica ? 'agendado' : 'aguardando_aprovacao'; log('gerente', 'post_aprovado', `Aprovou "${p.titulo_arte}" (nota ${r.nota})`); }
        else { log('gerente', 'post_reprovado', `Pediu ajustes em "${p.titulo_arte}" (nota ${r.nota}): ${r.feedback}`, 'warning'); revise(p, r.feedback, 'gerente'); }
      }
      if (g.auditar_atendimentos) for (const c of S.convs.filter((x) => (S.msgs[x.id] || []).length > 1)) c.auditoria = { nota: c.pedidos.length ? 9 : 7, feedback: c.pedidos.length ? 'Venda concluída.' : 'Conduzir mais rápido para o fechamento.' };
      const k = kpis();
      if (k.items[0].progresso < 90) createTask({ agent: 'trafego', title: `Projeção de faturamento em ${k.items[0].progresso}% da meta: propor ação para recuperar vendas`, created_by: 'gerente', priority: 'alta' });
      const abaixo = k.items.filter((i) => i.progresso < 90);
      const rep = { agent: 'gerente', id: uid('rep_'), created_at: now(), titulo: abaixo.length ? `${abaixo.length} indicador(es) abaixo da meta` : 'Tudo dentro da meta 🎉', destaques: k.items.filter((i) => i.progresso >= 100).map((i) => `${i.label} batendo a meta (${i.progresso}%)`), riscos: abaixo.map((i) => `${i.label} em ${i.progresso}% da meta`), proximas_acoes: ['Tráfego: reforçar campanhas com melhor ROAS', 'Social: manter agenda de posts da semana', 'Atendente: oferecer complemento em todo fechamento'] };
      S.reports.unshift(rep); log('gerente', 'relatorio', `Relatório gerado: ${rep.titulo}`, 'success');
      return rep;
    });
  }
  async function runTasks() {
    for (const t of S.tasks.filter((x) => x.status === 'todo' && ['social', 'trafego'].includes(x.agent)).slice(0, 2)) {
      t.status = 'doing';
      if (t.agent === 'social') {
        await working('social', `Trabalhando em: ${t.title}`, () => {
          const p = PRODUCTS[2]; const formato = /stor/i.test(t.title) ? 'story' : /an[uú]ncio|criativo|campanha/i.test(t.title) ? 'anuncio' : 'feed';
          createPost({ formato, tema: t.title, produto: p, titulo_arte: t.title.split(/[:—-]/)[0].split(' ').slice(0, 5).join(' '), subtitulo_arte: `${p.nome} com entrega no mesmo dia`, cta: 'Peça pelo WhatsApp', mostrar_preco: true, legenda: `${t.title}\n\nChame no WhatsApp! 💐`, hashtags: CFG.social.hashtags_fixas, layout: 'destaque', scheduled_at: formato === 'anuncio' ? null : new Date(Date.now() + 3 * 3600e3).toISOString() });
        });
      } else await analyze(`tarefa: ${t.title}`);
      t.status = 'done'; log(t.agent, 'tarefa_concluida', `Concluiu: ${t.title}`, 'success');
    }
  }

  // ---------- roteador ----------
  const scoreOf = (k) => { const a = k.items.filter((i) => i.agente); const by = (ag) => { const x = a.filter((i) => i.agente === ag).map((i) => Math.min(100, i.progresso)); return x.length ? Math.round(x.reduce((s, v) => s + v, 0) / x.length) : null; }; return { gerente: Math.round(k.items.slice(0, 3).reduce((s, i) => s + Math.min(100, i.progresso), 0) / 3), trafego: by('trafego'), social: by('social'), atendente: by('atendente') }; };
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = merge({ ...(a[k] || {}) }, v); else a[k] = v; } return a; };
  const routes = [
    ['POST', /^\/demo$/, () => ({ token: 'demo-token' })],
    ['GET', /^\/me$/, () => ({ tenant: S.tenant, ai: { enabled: false, model: null } })],
    ['GET', /^\/agents$/, () => KEYS.map((k) => ({ key: k, ...AGENTS[k], config: CFG[k] }))],
    ['GET', /^\/agents\/(\w+)\/config$/, (m) => CFG[m[1]]],
    ['PUT', /^\/agents\/(\w+)\/config$/, (m, b) => { merge(CFG[m[1]], b); log(m[1], 'config', `Configuração de ${AGENTS[m[1]].nome} atualizada pelo dono`); return CFG[m[1]]; }],
    ['POST', /^\/agents\/(\w+)\/run$/, async (m) => ({ ok: true, result: await ({ gerente: supervise, trafego: analyze, social: planWeek }[m[1]] || (() => ({})))() })],
    ['GET', /^\/team$/, () => {
      const k = kpis(); const sc = scoreOf(k); const dayAgo = Date.now() - 864e5;
      const open = S.tasks.filter((t) => ['todo', 'doing', 'review'].includes(t.status));
      return { kpis: k, relatorio: S.reports.find((r) => r.agent === 'gerente') || null, team: KEYS.map((key) => {
        const last = S.activity.find((a) => a.agent === key);
        return { key, ...AGENTS[key], nome_exibicao: CFG[key].nome_exibicao, enabled: CFG[key].enabled, status: !CFG[key].enabled ? 'pausado' : S.status[key] ? 'trabalhando' : 'online', atual: S.status[key] || last?.message || 'Aguardando próxima tarefa', nota: sc[key], acoes_24h: S.activity.filter((a) => a.agent === key && new Date(a.created_at) > dayAgo).length, tarefas_abertas: open.filter((t) => t.agent === key).length };
      }) };
    }],
    ['GET', /^\/activity$/, (m, b, q) => S.activity.slice(0, Number(q.get('limit')) || 50)],
    ['GET', /^\/kpis$/, () => kpis()],
    ['GET', /^\/tasks$/, (m, b, q) => S.tasks.filter((t) => (!q.get('status') || t.status === q.get('status')) && (!q.get('agent') || t.agent === q.get('agent')))],
    ['POST', /^\/tasks$/, (m, b) => { const t = createTask({ ...b, created_by: 'dono' }); setTimeout(runTasks, 1500); return t; }],
    ['PATCH', /^\/tasks\/([\w-]+)$/, (m, b) => Object.assign(S.tasks.find((t) => t.id === m[1]), b)],
    ['POST', /^\/tasks\/([\w-]+)\/approve$/, (m) => {
      const t = S.tasks.find((x) => x.id === m[1]);
      if (t.decision) apply({ ...t.decision, campanha: S.campaigns.find((k) => k.external_id === t.decision.external_id) });
      if (t.proposta) { S.campaigns.push({ external_id: uid('c_'), name: t.proposta.nome, status: 'pausada', orcamento_diario: t.proposta.orcamento_diario, gasto: 0, impressoes: 0, cliques: 0, ctr: 0, conversoes: 0, receita: 0, roas: 0, cpa: null, criada_pelo_agente: true }); log('trafego', 'campanha_criada', `Campanha "${t.proposta.nome}" criada após aprovação do dono`, 'success'); }
      t.status = 'done'; return t;
    }],
    ['GET', /^\/posts$/, (m, b, q) => S.posts.filter((p) => !q.get('status') || p.status === q.get('status'))],
    ['POST', /^\/posts\/([\w-]+)\/approve$/, (m) => { const p = S.posts.find((x) => x.id === m[1]); p.status = p.formato === 'anuncio' ? 'aprovado' : 'agendado'; p.scheduled_at ||= new Date(Date.now() + 6e5).toISOString(); log('social', 'post_aprovado_dono', `Dono aprovou "${p.titulo_arte}"`, 'success'); return p; }],
    ['POST', /^\/posts\/([\w-]+)\/reject$/, async (m, b) => { const p = S.posts.find((x) => x.id === m[1]); if (b?.feedback) { await working('social', `Refazendo "${p.titulo_arte}"`, () => revise(p, b.feedback, 'dono')); } else p.status = 'descartado'; return p; }],
    ['POST', /^\/posts\/([\w-]+)\/publish-now$/, (m) => { const p = S.posts.find((x) => x.id === m[1]); setTimeout(() => { p.status = 'publicado'; log('social', 'post_publicado', `Publicou ${p.formato} "${p.titulo_arte}" (demonstração)`, 'success'); }, 2500); return p; }],
    ['GET', /^\/conversations$/, () => S.convs.map((c) => ({ ...c, ultima: (S.msgs[c.id] || []).slice(-1)[0] || null }))],
    ['GET', /^\/conversations\/([\w-]+)\/messages$/, (m) => ({ conversation: S.convs.find((c) => c.id === m[1]), messages: S.msgs[m[1]] || [] })],
    ['POST', /^\/conversations\/([\w-]+)\/mode$/, (m, b) => { S.convs.find((c) => c.id === m[1]).status = b.mode === 'humano' ? 'humano' : 'bot'; return { ok: true }; }],
    ['POST', /^\/chat$/, (m, b) => chat(b)],
    ['GET', /^\/campaigns$/, () => ({ demo: true, campaigns: S.campaigns, ultima_analise: S.reports.find((r) => r.agent === 'trafego') || null })],
    ['POST', /^\/campaigns\/([\w-]+)\/pause$/, (m) => { apply({ acao: 'pausar', campanha: S.campaigns.find((k) => k.external_id === m[1]), motivo: 'ação manual do dono' }); return { ok: true }; }],
    ['PUT', /^\/integrations\/(\w+)$/, (m) => ({ test: { ok: false, error: 'Na demonstração não há conexão real. No sistema instalado, este botão valida o token na hora.' }, tenant: S.tenant })],
    ['DELETE', /^\/integrations\/(\w+)$/, () => S.tenant],
    ['PUT', /^\/webhook$/, (m, b) => { Object.assign(S.tenant.webhook, b); return S.tenant; }],
    ['POST', /^\/api-key\/rotate$/, () => ({ api_key: 'ifa_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) })],
  ];

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/v1')) return realFetch(input, opts);
    const path = url.pathname.slice(7); const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    for (const [mt, re, fn] of routes) {
      const m = path.match(re);
      if (m && mt === method) {
        try { const data = await fn(m, body, url.searchParams); return new Response(JSON.stringify(data ?? {}), { status: 200, headers: { 'content-type': 'application/json' } }); }
        catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
      }
    }
    return new Response(JSON.stringify({ error: 'Rota não disponível na demonstração' }), { status: 404 });
  };
  window.EventSource = class { constructor() { this._fn = (ev) => this.onmessage?.({ data: JSON.stringify(ev) }); listeners.add(this._fn); } close() { listeners.delete(this._fn); } };

  // Estado inicial: a equipe já trabalhou um pouco quando a página abre.
  window.__demoSeed = async () => {
    FAST = true;
    await Promise.all([analyze('análise programada'), planWeek('agenda semanal')]);
    await chat({ contact: 'sim_mariana', name: 'Mariana', text: 'Oi, quero flores pro aniversário da minha mãe' });
    await chat({ contact: 'sim_mariana', name: 'Mariana', text: 'Entrega no CEP 01310-100?' });
    await supervise();
    FAST = false;
  };
})();
