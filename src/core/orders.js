// Pedidos, clientes e indicadores de vendas (base compartilhada).
// Quando a loja está conectada, os pedidos são criados na iFlores e o status de pagamento
// chega pelo evento 'payment.confirmed'. O link enviado NÃO significa pagamento confirmado.
import { db } from './store.js';
import { uid, now, localDate, addDays, round2, norm } from './util.js';
import { log } from './events.js';

export const getOrder = (id) => db().get('orders', id);
export const listOrders = (tenantId, filter) => db().list('orders', tenantId, filter).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

function nextNumero(tenantId) {
  const n = db().list('orders', tenantId).reduce((m, o) => Math.max(m, o.numero || 0), 1000);
  return n + 1;
}

/** Pedido aberto do mesmo contato com os mesmos itens e data (evita duplicidade). */
export function pedidoEmAberto(tenantId, contato, { itens, data } = {}) {
  const chave = (it) => (it || []).map((i) => `${i.produto_id}x${i.qtd}`).sort().join(',');
  return listOrders(tenantId, (o) => o.contato === contato && o.status === 'aguardando_pagamento' && (!itens || chave(o.itens) === chave(itens)) && (!data || o.data === data))[0] || null;
}

export function criarPedido(tenantId, dados) {
  const existente = pedidoEmAberto(tenantId, dados.contato, dados);
  if (existente) return { ...existente, ja_existia: true };
  const subtotal = dados.itens.reduce((s, i) => s + i.preco * i.qtd, 0);
  const id = uid('ped_'); const numero = nextNumero(tenantId);
  const order = db().put('orders', {
    id, tenant_id: tenantId, numero, ...dados,
    subtotal: round2(subtotal), total: round2(subtotal + (dados.frete || 0)),
    status: 'aguardando_pagamento',
    pagamento: { status: 'pendente', link: `https://pagar.iflores.app.br/p/${id}`, enviado_em: null },
    created_at: now(),
  });
  upsertCliente(tenantId, { contato: dados.contato, nome: dados.comprador, ultima_compra: localDate(), ocasiao: dados.ocasiao, data_ocasiao: dados.data });
  return order;
}

export function confirmarPagamento(tenantId, orderId, origem = 'sistema') {
  const o = getOrder(orderId);
  if (!o || o.tenant_id !== tenantId) throw new Error('Pedido não encontrado');
  if (o.pagamento.status === 'confirmado') return o;
  const upd = db().put('orders', { ...o, status: 'pago', pagamento: { ...o.pagamento, status: 'confirmado', confirmado_em: now(), origem } });
  registrarVendaNoDia(tenantId, upd);
  log(tenantId, 'flora', `Pagamento do pedido #${o.numero} confirmado pelo ${origem === 'sistema' ? 'sistema de pagamento' : origem}`, { type: 'pagamento', kind: 'info', level: 'success', data: { order_id: o.id } });
  return upd;
}

function registrarVendaNoDia(tenantId, o) {
  const data = localDate(); const id = `${tenantId}:${data}`;
  const d = db().get('dias', id) || { id, tenant_id: tenantId, data, visitas: 0, carrinhos: 0, checkouts: 0, pedidos: 0, faturamento: 0, vendas: {}, buscas: {}, descontos: 0 };
  d.pedidos += 1; d.faturamento = round2(d.faturamento + o.total);
  for (const i of o.itens) d.vendas[i.produto_id] = (d.vendas[i.produto_id] || 0) + i.qtd;
  db().put('dias', d);
}

export function upsertCliente(tenantId, { contato, nome, ...rest }) {
  const id = `${tenantId}:${contato}`;
  const c = db().get('customers', id);
  return db().put('customers', { ...(c || { id, tenant_id: tenantId, contato, optin_marketing: false, historico: [] }), ...(nome ? { nome } : {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null)) });
}

// ---------------- indicadores ----------------
export function periodo(tenantId, ini, fim) {
  const rows = db().list('dias', tenantId, (d) => d.data >= ini && d.data <= fim);
  const s = rows.reduce((a, r) => {
    a.visitas += r.visitas; a.carrinhos += r.carrinhos; a.checkouts += r.checkouts; a.pedidos += r.pedidos; a.faturamento += r.faturamento;
    for (const [k, v] of Object.entries(r.vendas || {})) a.vendas[k] = (a.vendas[k] || 0) + v;
    for (const [k, v] of Object.entries(r.buscas || {})) a.buscas[k] = (a.buscas[k] || 0) + v;
    return a;
  }, { visitas: 0, carrinhos: 0, checkouts: 0, pedidos: 0, faturamento: 0, vendas: {}, buscas: {} });
  return { ...s, ini, fim, dias: rows.length, faturamento: round2(s.faturamento), ticket: s.pedidos ? round2(s.faturamento / s.pedidos) : 0, conversao: s.visitas ? s.pedidos / s.visitas : 0 };
}

/** Compara a semana atual com a anterior (períodos equivalentes de 7 dias). */
export function compararSemanas(tenantId, hoje = localDate()) {
  const fim = addDays(hoje, -1);
  return { atual: periodo(tenantId, addDays(fim, -6), fim), anterior: periodo(tenantId, addDays(fim, -13), addDays(fim, -7)) };
}

export function funil(p) {
  const etapas = [['visitas', 'Visitaram a loja'], ['carrinhos', 'Colocaram no carrinho'], ['checkouts', 'Iniciaram o pagamento'], ['pedidos', 'Concluíram o pedido']];
  return etapas.map(([k, label], i) => ({ etapa: k, label, valor: p[k], taxa: i ? (p[etapas[i - 1][0]] ? p[k] / p[etapas[i - 1][0]] : 0) : 1 }));
}

/** Registra uma pergunta feita à Flora (alimenta a Mari e o Alex). */
export function registrarPergunta(tenantId, tema, exemplo) {
  const id = `${tenantId}:${norm(tema)}`;
  const q = db().get('perguntas', id) || { id, tenant_id: tenantId, tema, total: 0, exemplos: [] };
  q.total += 1; if (exemplo && q.exemplos.length < 5 && !q.exemplos.includes(exemplo)) q.exemplos.push(exemplo);
  db().put('perguntas', q);
}
export const topPerguntas = (tenantId, n = 5) => db().list('perguntas', tenantId).sort((a, b) => b.total - a.total).slice(0, n);
