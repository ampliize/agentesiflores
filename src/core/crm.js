// CRM da floricultura, sincronizado com a iFlores.
// Contato = pessoa que conversou ou comprou. Etapas do funil são calculadas a partir de conversas e
// pedidos (não dependem de alguém lembrar de mover o card).
import { db } from './store.js';
import { uid, now, norm, localDate, addDays, diffDays, round2 } from './util.js';
import { log, publish } from './events.js';
import { enfileirar, listarOutbox } from './outbox.js';
import { IFloresClient } from './integrations/iflores.js';
import { getTenant } from './team.js';

export const ETAPAS = {
  lead: 'Conversou, sem pedido',
  negociando: 'Escolhendo produto',
  aguardando_pagamento: 'Aguardando pagamento',
  cliente: 'Cliente',
  recorrente: 'Cliente recorrente',
  inativo: 'Inativo (90+ dias)',
};

/** Telefone só com dígitos e DDI 55 (para casar contatos do WhatsApp, do site e da iFlores). */
export function normTel(s) {
  let d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d || String(s ?? '');
}
const idContato = (t, tel) => `${t}:${normTel(tel)}`;

export function getContato(tenantId, tel) { return db().get('customers', idContato(tenantId, tel)); }

/** Cria ou atualiza um contato. `origem` registra de onde veio a informação. */
export async function salvarContato(tenantId, dados, { origem = 'painel', sincronizar = true } = {}) {
  const tel = normTel(dados.contato);
  const id = idContato(tenantId, tel);
  const atual = (await db().get('customers', id)) || { id, tenant_id: tenantId, contato: tel, criado_por: origem, tags: [], datas: [], optin_marketing: false };
  const limpo = Object.fromEntries(Object.entries(dados).filter(([, v]) => v !== undefined));
  if ('optin_marketing' in limpo && limpo.optin_marketing !== atual.optin_marketing) { limpo.optin_em = now(); limpo.optin_origem = origem; }
  await db().put('customers', { ...atual, ...limpo, contato: tel, ultima_atualizacao_origem: origem });
  await recalcular(tenantId, tel);
  if (sincronizar && origem !== 'iflores') await enfileirar(tenantId, 'cliente.upsert', { contato: tel }, `cliente:${tel}`);
  return db().get('customers', id);
}

/** Recalcula etapa e totais do contato a partir dos pedidos e da conversa. */
export async function recalcular(tenantId, tel) {
  const id = idContato(tenantId, tel); const c = await db().get('customers', id); if (!c) return null;
  const pedidos = await db().list('orders', tenantId, (o) => normTel(o.contato) === c.contato && o.status !== 'cancelado');
  const pagos = pedidos.filter((o) => o.pagamento?.status === 'confirmado');
  const conv = (await db().list('conversations', tenantId, (x) => normTel(x.contato) === c.contato)).sort((a, b) => ((a.ultima_cliente_em || '') < (b.ultima_cliente_em || '') ? 1 : -1))[0];
  const ultimaCompra = pagos.map((o) => o.created_at.slice(0, 10)).sort().pop() || c.ultima_compra || null;
  let etapa = 'lead';
  if (pedidos.some((o) => o.status === 'aguardando_pagamento')) etapa = 'aguardando_pagamento';
  else if (pagos.length >= 2) etapa = 'recorrente';
  else if (pagos.length === 1 || (ultimaCompra && !pedidos.length)) etapa = 'cliente';
  else if (conv?.estado?.itens?.length) etapa = 'negociando';
  if (['cliente', 'recorrente'].includes(etapa) && ultimaCompra && diffDays(localDate(), ultimaCompra) > 90) etapa = 'inativo';
  return db().put('customers', { ...c, etapa, pedidos_pagos: pagos.length, total_gasto: round2(pagos.reduce((s, o) => s + o.total, 0)), ultima_compra: ultimaCompra, ultima_interacao: [conv?.ultima_cliente_em, pedidos[0]?.created_at, c.ultima_interacao].filter(Boolean).sort().pop() || null });
}

export async function listarContatos(tenantId, { busca = '', etapa, tag, optin } = {}) {
  const b = norm(busca);
  return (await db().list('customers', tenantId, (c) => (!etapa || c.etapa === etapa) && (!tag || (c.tags || []).includes(tag)) && (optin == null || !!c.optin_marketing === optin)
    && (!b || norm(`${c.nome} ${c.contato} ${c.email || ''} ${(c.tags || []).join(' ')}`).includes(b))))
    .sort((a, b2) => ((a.ultima_interacao || '') < (b2.ultima_interacao || '') ? 1 : -1));
}

export async function funil(tenantId) {
  const cs = await db().list('customers', tenantId);
  return Object.fromEntries(Object.keys(ETAPAS).map((k) => [k, cs.filter((c) => c.etapa === k).length]));
}

/** Linha do tempo do contato: mensagens, pedidos, automações e notas. */
export async function linhaDoTempo(tenantId, tel) {
  const c = await getContato(tenantId, tel); if (!c) return null;
  const ev = [];
  for (const conv of await db().list('conversations', tenantId, (x) => normTel(x.contato) === c.contato)) {
    for (const m of await db().list('messages', tenantId, (x) => x.conversation_id === conv.id)) ev.push({ em: m.em, tipo: 'mensagem', quem: m.role, canal: conv.canal, texto: m.texto });
  }
  for (const o of await db().list('orders', tenantId, (x) => normTel(x.contato) === c.contato)) ev.push({ em: o.created_at, tipo: 'pedido', texto: `Pedido #${o.numero}: ${o.itens.map((i) => i.nome).join(', ')} (${o.status.replace(/_/g, ' ')})`, total: o.total });
  for (const a of await db().list('automacao_execucoes', tenantId, (x) => normTel(x.contato) === c.contato)) ev.push({ em: a.created_at, tipo: 'automacao', texto: `${a.nome}: ${a.status === 'enviado' ? 'enviada' : `não enviada (${a.motivo})`}` });
  for (const n of c.notas || []) ev.push({ em: n.em, tipo: 'nota', texto: n.texto, quem: n.por });
  return { contato: c, eventos: ev.sort((a, b) => (a.em < b.em ? 1 : -1)).slice(0, 200) };
}

export async function adicionarNota(tenantId, tel, texto, por = 'dono') {
  const c = await getContato(tenantId, tel); if (!c) throw Object.assign(new Error('Contato não encontrado'), { status: 404 });
  return db().put('customers', { ...c, notas: [...(c.notas || []), { em: now(), texto, por }] });
}

// ======================= SINCRONIZAÇÃO COM A IFLORES =======================
const estadoId = (t) => `${t}:sync`;
export async function estadoSync(tenantId) {
  const conectado = !!(await getTenant(tenantId))?.iflores?.connected;
  const e = (await db().get('sync_estado', estadoId(tenantId))) || { id: estadoId(tenantId), tenant_id: tenantId, cursor: null, ultima: null, erros: [] };
  const pend = (await listarOutbox(tenantId)).filter((o) => o.status !== 'enviado');
  return { ...e, conectado, fila_pendente: pend.filter((o) => o.status === 'pendente').length, fila_falhou: pend.filter((o) => o.status === 'falhou').length };
}

/** Recebe clientes e pedidos alterados na iFlores desde o último cursor (idempotente). */
export async function sincronizar(tenantId) {
  const cli = new IFloresClient(await getTenant(tenantId));
  const e = await estadoSync(tenantId);
  if (!cli.conectado) { await db().put('sync_estado', { ...e, ultima: now(), resultado: 'Loja ainda não conectada à iFlores: os dados ficam na fila e serão enviados assim que conectar.' }); return { conectado: false }; }
  let recebidos = 0;
  try {
    const r = await cli.alteracoesDesde(e.cursor);
    for (const c of r.clientes || []) { await aplicarClienteIflores(tenantId, c); recebidos++; }
    for (const o of r.pedidos || []) { await aplicarPedidoIflores(tenantId, o); recebidos++; }
    await db().put('sync_estado', { ...e, cursor: r.cursor ?? e.cursor, ultima: now(), resultado: `${recebidos} registro(s) recebidos`, erros: [] });
  } catch (err) {
    await db().put('sync_estado', { ...e, ultima: now(), resultado: 'falhou', erros: [...(e.erros || []), { em: now(), erro: err.message }].slice(-10) });
    throw err;
  }
  await processarFila(tenantId);
  return { conectado: true, recebidos };
}

export function aplicarClienteIflores(tenantId, c) {
  if (!c?.telefone && !c?.contato) return null;
  return salvarContato(tenantId, { contato: c.telefone || c.contato, nome: c.nome, email: c.email, external_id: c.id, optin_marketing: c.aceita_marketing ?? undefined, datas: c.datas, tags: c.tags }, { origem: 'iflores' });
}

export async function aplicarPedidoIflores(tenantId, o) {
  if (!o?.id) return null;
  const id = `${tenantId}:ifl:${o.id}`;
  const atual = (await db().get('orders', id)) || (await db().list('orders', tenantId, (x) => x.external_id === o.id))[0];
  const doc = { ...(atual || { id, tenant_id: tenantId, origem: o.origem || 'iflores', created_at: o.criado_em || now() }), external_id: o.id, numero: o.numero ?? atual?.numero, contato: normTel(o.telefone || o.contato), comprador: o.cliente_nome || atual?.comprador, itens: o.itens || atual?.itens || [], total: o.total ?? atual?.total, data: o.data_entrega || atual?.data, modalidade: o.modalidade || atual?.modalidade, status: o.status || atual?.status, pagamento: { ...(atual?.pagamento || {}), status: o.pago ? 'confirmado' : atual?.pagamento?.status || 'pendente', link: o.link_pagamento || atual?.pagamento?.link } };
  const salvo = await db().put('orders', doc);
  if (atual && atual.pagamento?.status !== 'confirmado' && doc.pagamento.status === 'confirmado') publish(tenantId, 'pedido.pago', { order_id: salvo.id });
  if (atual && atual.status !== doc.status) publish(tenantId, 'pedido.status', { order_id: salvo.id, status: doc.status });
  if (doc.contato) { if (!(await getContato(tenantId, doc.contato))) await salvarContato(tenantId, { contato: doc.contato, nome: doc.comprador }, { origem: 'iflores' }); await recalcular(tenantId, doc.contato); }
  return salvo;
}

/** Envia a fila de saída para a iFlores, com novas tentativas e espera crescente. */
export async function processarFila(tenantId, agora = new Date()) {
  const cli = new IFloresClient(await getTenant(tenantId));
  if (!cli.conectado) return { enviados: 0, aguardando_conexao: (await listarOutbox(tenantId, 'pendente')).length };
  let enviados = 0;
  for (const o of (await listarOutbox(tenantId, 'pendente')).filter((x) => x.proxima_em <= agora.toISOString()).slice(0, 50)) {
    try {
      if (o.tipo === 'cliente.upsert') { const c = await getContato(tenantId, o.payload.contato); if (c) { const r = await cli.salvarCliente({ id: c.external_id, telefone: c.contato, nome: c.nome, email: c.email, aceita_marketing: !!c.optin_marketing, tags: c.tags, datas: c.datas }); if (r?.id && !c.external_id) await db().put('customers', { ...c, external_id: r.id }); } }
      else if (o.tipo === 'pedido.criar') { const p = await db().get('orders', o.payload.order_id); if (p && !p.external_id) { const r = await cli.criarPedido(p); if (r?.id) await db().put('orders', { ...p, external_id: r.id, pagamento: { ...p.pagamento, link: r.link_pagamento || p.pagamento.link } }); } }
      else if (o.tipo === 'alteracao.aplicar') await cli.aplicar(o.payload);
      await db().put('outbox', { ...o, status: 'enviado', enviado_em: now(), erro: null }); enviados++;
    } catch (err) {
      const tentativas = o.tentativas + 1; const falhou = tentativas >= 8;
      await db().put('outbox', { ...o, tentativas, erro: err.message, status: falhou ? 'falhou' : 'pendente', proxima_em: new Date(agora.getTime() + Math.min(6 * 3600e3, 2 ** tentativas * 60e3)).toISOString() });
      if (falhou) log(tenantId, 'alex', `Não consegui enviar à iFlores depois de 8 tentativas (${o.tipo}): ${err.message}`, { level: 'error', type: 'sync' });
    }
  }
  return { enviados };
}

export async function reenviarFalhas(tenantId) {
  for (const o of await listarOutbox(tenantId, 'falhou')) await db().put('outbox', { ...o, status: 'pendente', tentativas: 0, proxima_em: now() });
}

export { uid, addDays };
