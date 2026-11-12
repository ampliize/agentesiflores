// Loja de demonstração: dados realistas para mostrar cada agente trabalhando.
// Nada disso é usado em lojas reais; ali a base vem da iFlores.
import { db } from './store.js';
import { uid, now, localDate, addDays, weekday, round2 } from './util.js';
import { demoPhotoUrl } from './demo-photos.js';
import { DEFAULT_SETTINGS } from './catalog.js';
import { AGENT_KEYS } from './team.js';

const INSUMOS = [
  ['rosa_verm', 'Rosa vermelha', 'haste', 3.2, 'flor', 12, 60, 20], ['rosa_branca', 'Rosa branca', 'haste', 3.4, 'flor', 12, 36, 20], ['rosa_rosa', 'Rosa cor-de-rosa', 'haste', 3.2, 'flor', 12, 24, 20],
  ['girassol', 'Girassol', 'haste', 4.5, 'flor', 10, 18, 10], ['lirio', 'Lírio', 'haste', 6.0, 'flor', 15, 0, 10], ['margarida', 'Margarida', 'maço', 9.0, 'flor', 15, 6, 5],
  ['astromelia', 'Astromélia', 'haste', 2.2, 'flor', 10, 30, 10], ['eucalipto', 'Eucalipto', 'galho', 0.8, 'folhagem', 8, 80, 20], ['gipso', 'Gipsofila', 'maço', 7.5, 'flor', 10, 4, 5],
  ['orq', 'Orquídea Phalaenopsis (vaso)', 'un', 38, 'planta', 0, 8, 1], ['cachepo', 'Cachepô de cerâmica', 'un', 18, 'embalagem', 0, 10, 1], ['kraft', 'Papel kraft', 'folha', 1.2, 'embalagem', 0, 120, 50],
  ['fita', 'Fita de cetim', 'm', 0.9, 'embalagem', 0, 200, 50], ['vaso_vidro', 'Vaso de vidro', 'un', 16, 'embalagem', 0, 12, 6], ['caixa_box', 'Caixa box redonda', 'un', 14, 'embalagem', 0, 15, 5],
  ['cesta_vime', 'Cesta de vime', 'un', 22, 'embalagem', 0, 8, 4], ['kit_cafe', 'Kit café da manhã (pães, frutas, suco)', 'un', 92, 'alimento', 5, 0, 1], ['ferrero', 'Ferrero Rocher 8 un.', 'cx', 24, 'alimento', 0, 20, 10],
  ['cartao', 'Cartão impresso', 'un', 1.5, 'acessorio', 0, 300, 100], ['pinheiro', 'Ramo de pinheiro', 'galho', 2.5, 'folhagem', 10, 0, 10],
];

const P = [
  { id: 'encanto', nome: 'Buquê Encanto 12 Rosas Vermelhas', preco: 189.9, categoria: 'Buquês', estilo: 'rosas_vermelhas', descricao: 'Doze rosas vermelhas colombianas com eucalipto e gipsofila, embrulhadas em papel kraft.', tags: ['namorados', 'aniversario', 'amor'], composicao: [['rosa_verm', 12], ['eucalipto', 6], ['gipso', 1], ['kraft', 2], ['fita', 1.5]], peso: 22, busca: 60 },
  { id: 'paz', nome: 'Buquê Paz 12 Rosas Brancas', preco: 189.9, categoria: 'Buquês', estilo: 'rosas_brancas', descricao: 'Doze rosas brancas com eucalipto, em papel de seda verde.', tags: ['condolencias', 'casamento', 'paz'], composicao: [['rosa_branca', 12], ['eucalipto', 6], ['kraft', 2], ['fita', 1.5]], peso: 7, busca: 18 },
  { id: 'primavera', nome: 'Buquê Primavera', preco: 129.9, categoria: 'Buquês', estilo: 'campestre', descricao: 'Rosas cor-de-rosa, margaridas e astromélias em tons alegres.', tags: ['aniversario', 'amizade', 'mae'], composicao: [['rosa_rosa', 6], ['margarida', 1], ['astromelia', 5], ['eucalipto', 4], ['kraft', 2], ['fita', 1]], peso: 14, busca: 35 },
  { id: 'girassois', nome: 'Arranjo Girassóis Alegria', preco: 149.9, categoria: 'Arranjos', estilo: 'girassois', descricao: 'Seis girassóis em vaso de vidro com laço amarelo.', tags: ['alegria', 'melhoras', 'amizade'], composicao: [['girassol', 6], ['eucalipto', 4], ['vaso_vidro', 1], ['fita', 1]], peso: 9, busca: 22 },
  { id: 'orquidea', nome: 'Orquídea Phalaenopsis Branca', preco: 139.9, categoria: 'Plantas', estilo: 'orquidea', descricao: 'Orquídea com duas hastes em cachepô de cerâmica.', tags: ['mae', 'corporativo', 'elegante'], composicao: [['orq', 1], ['cachepo', 1], ['fita', 1]], estoque: 8, peso: 8, busca: 20 },
  { id: 'cesta', nome: 'Cesta Café da Manhã com Flores', preco: 239.9, categoria: 'Cestas', estilo: 'cesta', descricao: 'Cesta com pães, frutas, suco, chocolates e um mini buquê de rosas.', tags: ['aniversario', 'mae', 'surpresa'], composicao: [['kit_cafe', 1], ['cesta_vime', 1], ['rosa_verm', 4], ['astromelia', 3], ['fita', 2], ['cartao', 1]], peso: 9, busca: 26, cresce: true },
  { id: 'box', nome: 'Box Rosas & Ferrero', preco: 219.9, categoria: 'Presentes', estilo: 'box', descricao: 'Caixa com nove rosas vermelhas e oito bombons Ferrero Rocher.', tags: ['namorados', 'amor', 'aniversario'], composicao: [['rosa_verm', 9], ['caixa_box', 1], ['ferrero', 1], ['fita', 1]], peso: 10, busca: 24 },
  { id: 'romance', nome: 'Arranjo Romance', preco: 169.9, categoria: 'Arranjos', estilo: 'rosas_vermelhas', descricao: 'Arranjo baixo com rosas vermelhas, lírios e folhagens.', tags: ['amor', 'aniversario'], composicao_texto: 'rosas vermelhas, lírios e folhagens', custo_informado: 58, peso: 5, busca: 12 },
  { id: 'campestre', nome: 'Mini Buquê Campestre', preco: 79.9, categoria: 'Buquês', estilo: 'campestre', descricao: 'Flores do campo sortidas para um carinho rápido.', tags: ['carinho', 'agradecimento'], peso: 9, busca: 15 },
  { id: 'lirios', nome: 'Buquê Lírios do Campo', preco: 159.9, categoria: 'Buquês', estilo: 'rosas_brancas', descricao: 'Lírios brancos perfumados com folhagens.', tags: ['mae', 'elegante'], composicao: [['lirio', 6], ['eucalipto', 4], ['kraft', 2], ['fita', 1]], estoque: 0, peso: 0, busca: 41 },
  { id: 'natal', nome: 'Arranjo Natalino', preco: 159.9, categoria: 'Arranjos', estilo: 'rosas_vermelhas', descricao: 'Rosas vermelhas, pinheiro e detalhes dourados para a mesa de Natal.', tags: ['natal'], composicao: [['rosa_verm', 6], ['pinheiro', 4], ['vaso_vidro', 1], ['fita', 2]], comemorativo: true, peso: 0, busca: 6 },
  { id: 'chocolate', nome: 'Chocolates Ferrero Rocher (8 un.)', preco: 39.9, categoria: 'Complementos', estilo: 'chocolate', tipo: 'complemento', descricao: 'Caixa com 8 bombons.', composicao: [['ferrero', 1]], peso: 6 },
  { id: 'cartao', nome: 'Cartão personalizado', preco: 9.9, categoria: 'Complementos', estilo: 'cartao', tipo: 'complemento', descricao: 'Cartão com a sua mensagem impressa.', composicao: [['cartao', 1]], peso: 10 },
  { id: 'pelucia', nome: 'Pelúcia Urso 25 cm', preco: 59.9, categoria: 'Complementos', estilo: 'pelucia', tipo: 'complemento', descricao: 'Ursinho de pelúcia macio.', custo_informado: 28, peso: 3 },
];

const BAIRROS = [['Vila Mariana', 12], ['Moema', 15], ['Saúde', 12], ['Jardins', 15], ['Pinheiros', 18], ['Itaim Bibi', 18], ['Vila Madalena', 20], ['Ipiranga', 14]];

function rnd(seed) { let x = seed; return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; }

export function seedDemo(nome = 'Floricultura Jardim Encantado') {
  const tenantId = `loja_demo_${uid().slice(0, 6)}`;
  const t = tenantId; const hoje = localDate(); const r = rnd(42);
  db().put('tenants', { id: t, tenant_id: t, name: nome, iflores_store_id: null, demo: true, status: 'active',
    plano: { agentes: Object.fromEntries(AGENT_KEYS.map((k) => [k, true])), modelo: 'combo_validacao' },
    iflores: { base_url: '', token: '', connected: false },
    integrations: { whatsapp: { connected: false }, meta_ads: { connected: false }, google_ads: { connected: false }, instagram: { connected: false } },
    webhook: { url: '', enabled: false } });

  const iid = (k) => `${t}:${k}`; const pid = (k) => `${t}:${k}`;
  for (const [k, nomeI, un, custo, tipo, perda, estoque, multiplo] of INSUMOS) db().put('insumos', { id: iid(k), tenant_id: t, nome: nomeI, unidade: un, custo, tipo, perda_pct: perda, estoque, multiplo });
  for (const p of P) {
    db().put('products', { id: pid(p.id), tenant_id: t, nome: p.nome, preco: p.preco, categoria: p.categoria, descricao: p.descricao, tags: p.tags || [], tipo: p.tipo || 'produto', ativo: true, destaque: ['primavera', 'orquidea'].includes(p.id),
      estoque: p.estoque ?? null, comemorativo: !!p.comemorativo, composicao: (p.composicao || []).map(([i, q]) => ({ insumo_id: iid(i), qtd: q })), composicao_texto: p.composicao_texto, custo_informado: p.custo_informado ?? null });
    const n = p.tipo === 'complemento' ? 1 : p.id === 'campestre' ? 1 : 3;
    for (let k = 0; k < n; k++) db().put('photos', { id: uid('foto_'), tenant_id: t, url: demoPhotoUrl(p.estilo, k + 1), produto_id: pid(p.id), legenda: `${p.nome}${k ? ` (${k + 1})` : ''}`, origem: k === 0 ? 'iflores' : 'lojista', demo: true, usos: 0, ultimo_uso: k === 0 && r() > 0.5 ? addDays(hoje, -5) : null });
  }
  db().put('settings', { ...DEFAULT_SETTINGS, id: t, tenant_id: t, fretes: BAIRROS.map(([bairro, valor]) => ({ bairro, valor, ativo: true })) });

  // histórico de 70 dias: vendas crescem, mas a cesta (margem baixa) e os descontos crescem mais;
  // na última semana o número de pedidos cai porque mais clientes desistem no pagamento.
  const prods = P.filter((p) => p.peso);
  for (let d = 70; d >= 1; d--) {
    const data = addDays(hoje, -d); const wd = weekday(data);
    const fimDeSemana = wd === 'sex' || wd === 'sab';
    const recente = d <= 30; const ultimaSemana = d <= 7;
    const visitas = Math.round((wd === 'dom' ? 90 : fimDeSemana ? 230 : 170) * (recente ? 1.15 : 1) * (0.9 + r() * 0.2));
    const carrinhos = Math.round(visitas * (0.085 + r() * 0.01));
    const checkouts = Math.round(carrinhos * 0.62);
    const pedidos = wd === 'dom' ? 0 : Math.max(1, Math.round(checkouts * (ultimaSemana ? 0.5 : 0.74)));
    const vendas = {}; let fat = 0;
    const pesos = prods.map((p) => p.peso * (p.cresce && recente ? 2.4 : 1));
    const soma = pesos.reduce((a, b) => a + b, 0);
    for (let k = 0; k < pedidos; k++) {
      let x = r() * soma; let i = 0; while (x > pesos[i]) { x -= pesos[i]; i++; }
      const p = prods[Math.min(i, prods.length - 1)];
      if (p.tipo === 'complemento') continue;
      vendas[pid(p.id)] = (vendas[pid(p.id)] || 0) + 1; fat += p.preco;
      if (r() < 0.35) { vendas[pid('cartao')] = (vendas[pid('cartao')] || 0) + 1; fat += 9.9; }
      if (r() < 0.12) { vendas[pid('chocolate')] = (vendas[pid('chocolate')] || 0) + 1; fat += 39.9; }
    }
    const descontos = round2(fat * (recente ? 0.06 : 0.015));
    const buscas = Object.fromEntries(P.filter((p) => p.busca).map((p) => [pid(p.id), Math.round((p.busca / 7) * (0.7 + r() * 0.6))]));
    db().put('dias', { id: `${t}:${data}`, tenant_id: t, data, visitas, carrinhos, checkouts, pedidos, faturamento: round2(fat - descontos), descontos, vendas, buscas });
  }

  // campanhas: soma 60/dia = teto; a de rosas vende muito bem; uma anuncia produto esgotado
  const camp = (plataforma, nome, orcamento, produtos, [gasto, imp, cliques, compras, receita], extra = {}) => db().put('campaigns', { id: uid('cmp_'), tenant_id: t, plataforma, nome, status: 'ativa', orcamento_diario: orcamento, produto_ids: produtos.map(pid), metricas: { gasto, impressoes: imp, cliques, ctr: round2((cliques / imp) * 100), compras, receita, roas: gasto ? receita / gasto : 0 }, ...extra });
  camp('meta', 'Rosas — Conversão', 25, ['encanto', 'box'], [168, 9800, 214, 9, 1739]);
  camp('meta', 'Girassóis — Alcance bairros', 15, ['girassois'], [102, 14200, 88, 0, 0]);
  camp('meta', 'Lírios — Conversão', 10, ['lirios'], [64, 3900, 61, 1, 159.9]);
  camp('google', 'Pesquisa — Cesta de café', 10, ['cesta'], [71, 1800, 66, 2, 479.8], { tipo: 'pesquisa' });

  // clientes e conversas
  const ano = addDays(hoje, -365 + 5);
  db().put('customers', { id: `${t}:5511988887777`, tenant_id: t, contato: '5511988887777', nome: 'Renata Alves', optin_marketing: true, ocasiao: 'aniversário da mãe', data_ocasiao: ano, ultima_compra: ano });
  db().put('customers', { id: `${t}:5511977776666`, tenant_id: t, contato: '5511977776666', nome: 'Paulo Lima', optin_marketing: false, ocasiao: 'aniversário', data_ocasiao: ano });
  const conv = { id: `${t}:whatsapp:5511966665555`, tenant_id: t, canal: 'whatsapp', contato: '5511966665555', nome: 'Juliana Costa', status: 'flora', ultima_cliente_em: new Date(Date.now() - 3 * 3600e3).toISOString(), estado: { etapa: 'escolha', itens: [{ produto_id: pid('primavera'), nome: 'Buquê Primavera', preco: 129.9, qtd: 1 }], upsell_oferecido: true } };
  db().put('conversations', conv);
  const m = (role, texto, minAtras) => db().put('messages', { id: uid('msg_'), tenant_id: t, conversation_id: conv.id, role, texto, em: new Date(Date.now() - minAtras * 60e3).toISOString() });
  m('cliente', 'Oi! Queria um buquê para a minha professora, até uns 150', 185);
  m('flora', 'Olá! Aqui é a Flora, da Floricultura Jardim Encantado. Separei estas opções até R$ 150,00:\n1. Buquê Primavera: R$ 129,90\n2. Mini Buquê Campestre: R$ 79,90\n3. Orquídea Phalaenopsis Branca: R$ 139,90\n\nQual delas você prefere?', 184);
  m('cliente', 'O primeiro', 181);
  m('flora', 'Ótima escolha! Buquê Primavera por R$ 129,90.\n\nQuer incluir algum complemento?\n• Cartão personalizado: R$ 9,90\n• Chocolates Ferrero Rocher (8 un.): R$ 39,90\n• Pelúcia Urso 25 cm: R$ 59,90\n(ou responda "não")', 180);

  for (const [tema, total, ex] of [['entrega', 14, 'Vocês entregam hoje ainda?'], ['frete', 9, 'Quanto fica o frete para Pinheiros?'], ['pagamento', 6, 'Aceita Pix?'], ['horário da loja', 4, 'Até que horas vocês abrem no sábado?'], ['troca e garantia', 3, 'Quanto tempo as rosas duram?']]) {
    db().put('perguntas', { id: `${t}:${tema}`, tenant_id: t, tema, total, exemplos: [ex] });
  }
  // pedidos para hoje e amanhã (produção)
  for (const [k, data, st] of [['encanto', hoje, 'pago'], ['orquidea', hoje, 'em_producao'], ['box', addDays(hoje, 1), 'pago'], ['primavera', addDays(hoje, 1), 'aguardando_pagamento']]) {
    const p = P.find((x) => x.id === k);
    db().put('orders', { id: uid('ped_'), tenant_id: t, numero: 1000 + Math.floor(r() * 900), contato: `55119${Math.floor(r() * 1e8)}`, canal: 'site', comprador: 'Cliente do site', itens: [{ produto_id: pid(k), nome: p.nome, preco: p.preco, qtd: 1 }], modalidade: 'entrega', data, janela: '12h-15h', bairro: 'Moema', frete: 15, subtotal: p.preco, total: p.preco + 15, status: st, pagamento: { status: st === 'aguardando_pagamento' ? 'pendente' : 'confirmado', link: 'https://pagar.iflores.app.br/p/demo' }, origem: 'site', created_at: now() });
  }
  return t;
}
