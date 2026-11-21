// Base compartilhada da floricultura: produtos, insumos (flores e materiais), regras de entrega,
// fretes e calendário. Todos os agentes leem daqui; alterações passam por applyChanges(),
// que registra histórico, permite reverter e avisa os outros agentes.
import { db } from './store.js';
import { uid, now, norm, localDate, localTime, weekday, contemTermos, tokens, STOP } from './util.js';
import { publish, log } from './events.js';
import { enfileirar } from './outbox.js';

// ---------------- leitura ----------------
export const getProduct = (id) => db().get('products', id);
export const listProducts = (tenantId) => db().list('products', tenantId).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
export const listInsumos = (tenantId) => db().list('insumos', tenantId).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
export const insumoMap = (tenantId) => Object.fromEntries(listInsumos(tenantId).map((i) => [i.id, i]));

export const DEFAULT_SETTINGS = {
  horarios: { seg: ['08:00', '19:00'], ter: ['08:00', '19:00'], qua: ['08:00', '19:00'], qui: ['08:00', '19:00'], sex: ['08:00', '19:00'], sab: ['08:00', '17:00'], dom: null },
  horarios_especiais: [],          // [{ data, abre, fecha, motivo }]
  datas_bloqueadas: [],            // [{ data, entrega, retirada, pedidos, motivo }]  true = bloqueado
  recebendo_pedidos: true,
  corte_mesmo_dia: '15:00',
  janelas: ['09h-12h', '12h-15h', '15h-18h'],
  capacidade_pedidos_dia: 40,
  retirada: { ativa: true, endereco: 'Rua das Hortênsias, 120' },
  fretes: [],                      // [{ bairro, valor, ativo }]
  modo_comemorativo: [],           // [{ nome, inicio, fim }]
  categorias: ['Buquês', 'Arranjos', 'Plantas', 'Cestas', 'Complementos'],
  destaques_home: [],              // ids dos produtos da página inicial, na ordem de exibição
};

export function getSettings(tenantId) {
  const s = db().get('settings', tenantId);
  return { ...DEFAULT_SETTINGS, ...(s || {}), id: tenantId, tenant_id: tenantId };
}

export function comemorativoAtivo(settings, data = localDate()) {
  return (settings.modo_comemorativo || []).find((m) => data >= m.inicio && data <= m.fim) || null;
}

/** Disponibilidade REAL do produto agora (ativo, estoque, catálogo comemorativo). */
export function disponibilidade(p, settings, data = localDate()) {
  if (!p) return { ok: false, motivo: 'produto não encontrado' };
  if (!p.ativo) return { ok: false, motivo: 'produto desativado' };
  if (p.estoque != null && p.estoque <= 0) return { ok: false, motivo: 'sem estoque' };
  if (p.comemorativo && !comemorativoAtivo(settings, data)) return { ok: false, motivo: 'só disponível no catálogo de data comemorativa' };
  return { ok: true };
}

export function composicaoTexto(p, imap) {
  if (p.composicao?.length) return p.composicao.map((c) => `${c.qtd} ${imap[c.insumo_id]?.nome || c.insumo_id}`).join(', ');
  return p.composicao_texto || '';
}

/** Produtos que o cliente pode comprar agora, com busca simples por texto. */
export function buscarProdutos(tenantId, { busca = '', precoMax, tipo = 'produto', data } = {}) {
  const s = getSettings(tenantId); const imap = insumoMap(tenantId);
  const disp = listProducts(tenantId).filter((p) => (tipo === 'todos' || (p.tipo || 'produto') === tipo) && disponibilidade(p, s, data).ok && (!precoMax || p.preco <= precoMax));
  const termos = tokens(busca).filter((w) => !STOP.has(w) && w.length > 2);
  if (!termos.length) return disp;
  const score = (p) => { const t = new Set(tokens(`${p.nome} ${p.descricao} ${p.categoria} ${(p.tags || []).join(' ')} ${composicaoTexto(p, imap)}`)); return termos.filter((w) => t.has(w)).length; };
  const ranked = disp.map((p) => [p, score(p)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return ranked;
}

/** Encontra produtos que usam um insumo/flor, pelo cadastro de composição, nome ou descrição. */
export function produtosComItem(tenantId, termo) {
  const imap = insumoMap(tenantId);
  const insumosAlvo = Object.values(imap).filter((i) => contemTermos(i.nome, termo)).map((i) => i.id);
  return listProducts(tenantId).map((p) => {
    if (p.composicao?.some((c) => insumosAlvo.includes(c.insumo_id))) return { p, por: 'composição' };
    if (contemTermos(p.nome, termo)) return { p, por: 'nome' };
    if (contemTermos(`${p.descricao} ${p.composicao_texto || ''}`, termo)) return { p, por: 'descrição' };
    return null;
  }).filter(Boolean);
}

/** Procura produto pelo nome (para comandos como "atualize o estoque do Buquê Encanto"). */
export function acharProduto(tenantId, texto) {
  const all = listProducts(tenantId); const t = norm(texto);
  const exato = all.filter((p) => t.includes(norm(p.nome)));
  if (exato.length) return exato.sort((a, b) => b.nome.length - a.nome.length).slice(0, 1);
  const tk = tokens(texto).filter((w) => !STOP.has(w) && w.length > 3);
  const scored = all.map((p) => [p, tokens(p.nome).filter((w) => tk.includes(w)).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!scored.length) return [];
  const best = scored[0][1];
  return scored.filter(([, n]) => n === best).map(([p]) => p);
}

// ---------------- entrega, retirada e frete ----------------
export function horarioDoDia(settings, data) {
  const esp = (settings.horarios_especiais || []).find((h) => h.data === data);
  if (esp) return esp.abre ? [esp.abre, esp.fecha] : null;
  return settings.horarios[weekday(data)] || null;
}

/** Verifica se é possível entregar/retirar em uma data, com o motivo quando não for. */
export function verificarData(tenantId, data, modalidade = 'entrega', agora = new Date()) {
  const s = getSettings(tenantId); const hoje = localDate(agora);
  if (!s.recebendo_pedidos) return { ok: false, motivo: 'A loja pausou o recebimento de pedidos no momento.' };
  if (!data || data < hoje) return { ok: false, motivo: 'Data inválida ou no passado.' };
  const bloq = (s.datas_bloqueadas || []).find((b) => b.data === data && (b.pedidos || b[modalidade]));
  if (bloq) return { ok: false, motivo: `Não teremos ${bloq.pedidos ? 'atendimento' : modalidade} nesse dia${bloq.motivo ? ` (${bloq.motivo})` : ''}.` };
  const h = horarioDoDia(s, data);
  if (!h) return { ok: false, motivo: 'A loja não abre nesse dia.' };
  if (modalidade === 'retirada' && !s.retirada?.ativa) return { ok: false, motivo: 'A loja não está trabalhando com retirada.' };
  let janelas = s.janelas;
  if (data === hoje) {
    const hora = localTime(agora);
    if (hora >= s.corte_mesmo_dia) return { ok: false, motivo: `Pedidos para hoje vão até ${s.corte_mesmo_dia}.` };
    janelas = janelas.filter((j) => Number(j.slice(0, 2)) >= Number(hora.slice(0, 2)) + 3);
    if (!janelas.length) return { ok: false, motivo: 'Não há mais janelas de entrega hoje.' };
  }
  const doDia = db().list('orders', tenantId, (o) => o.data === data && o.status !== 'cancelado').length;
  if (doDia >= s.capacidade_pedidos_dia) return { ok: false, motivo: 'A produção desse dia já está completa.' };
  return { ok: true, janelas: modalidade === 'retirada' ? [`${h[0]} às ${h[1]}`] : janelas, horario: h };
}

export function calcularFrete(tenantId, bairro) {
  const s = getSettings(tenantId);
  const f = (s.fretes || []).find((x) => x.ativo !== false && norm(x.bairro) === norm(bairro));
  if (f) return { ok: true, bairro: f.bairro, valor: f.valor };
  const parecido = (s.fretes || []).find((x) => x.ativo !== false && (norm(bairro).includes(norm(x.bairro)) || norm(x.bairro).includes(norm(bairro))));
  if (parecido) return { ok: true, bairro: parecido.bairro, valor: parecido.valor };
  return { ok: false, motivo: `Ainda não entregamos no bairro "${bairro}". Bairros atendidos: ${(s.fretes || []).filter((x) => x.ativo !== false).map((x) => x.bairro).join(', ')}.` };
}

// ---------------- alterações com histórico e reversão ----------------
/**
 * ops: [{ coll, id, after }]  (after = documento completo; null remove)
 * Registra o "antes" de cada documento para permitir desfazer.
 */
export function applyChanges(tenantId, { actor, comando = '', descricao, ops, origem = 'painel' }) {
  const s0 = getSettings(tenantId);
  const before = ops.map((o) => ({ ...o, before: db().get(o.coll, o.id) }));
  for (const o of before) {
    if (o.after === null) db().del(o.coll, o.id);
    else db().put(o.coll, { ...o.after, tenant_id: tenantId });
  }
  const change = db().put('changes', { id: uid('chg_'), tenant_id: tenantId, actor, comando, descricao, origem, ops: before.map(({ coll, id, before: b, after }) => ({ coll, id, before: b, after })), revertida: false, created_at: now() });
  log(tenantId, actor, descricao, { type: 'alteracao', kind: 'acao', level: 'success', data: { change_id: change.id } });
  enfileirar(tenantId, 'alteracao.aplicar', { change_id: change.id, descricao, ops: change.ops.map(({ coll, id, after }) => ({ coll, id, after })) });
  notificarDisponibilidade(tenantId, before, s0);
  return change;
}

export function undoChange(tenantId, changeId, actor = 'dono') {
  const c = db().get('changes', changeId);
  if (!c || c.tenant_id !== tenantId) throw new Error('Alteração não encontrada');
  if (c.revertida) throw new Error('Essa alteração já foi desfeita');
  const s0 = getSettings(tenantId);
  const ops = c.ops.map((o) => ({ coll: o.coll, id: o.id, before: db().get(o.coll, o.id), after: o.before }));
  for (const o of ops) { if (o.after === null) db().del(o.coll, o.id); else db().put(o.coll, o.after); }
  db().put('changes', { ...c, revertida: true, revertida_em: now(), revertida_por: actor });
  log(tenantId, actor === 'dono' ? 'alex' : actor, `Desfez: ${c.descricao}`, { type: 'reversao', kind: 'acao', level: 'warning', data: { change_id: c.id } });
  notificarDisponibilidade(tenantId, ops, s0);
  return db().get('changes', changeId);
}

export const listChanges = (tenantId) => db().list('changes', tenantId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

/** Compara disponibilidade antes/depois e avisa Flora, Mari e Caio pela base compartilhada. */
function notificarDisponibilidade(tenantId, ops, settingsAntes) {
  const s1 = getSettings(tenantId);
  const sairam = []; const voltaram = [];
  const ids = new Set(ops.filter((o) => o.coll === 'products').map((o) => o.id));
  // mudanças de calendário comemorativo afetam todos os produtos comemorativos
  if (ops.some((o) => o.coll === 'settings')) listProducts(tenantId).filter((p) => p.comemorativo).forEach((p) => ids.add(p.id));
  for (const id of ids) {
    const op = ops.find((o) => o.coll === 'products' && o.id === id);
    const antes = disponibilidade(op ? op.before : getProduct(id), settingsAntes).ok;
    const depois = disponibilidade(getProduct(id), s1).ok;
    if (antes && !depois) sairam.push(id);
    if (!antes && depois) voltaram.push(id);
  }
  if (sairam.length) publish(tenantId, 'produto.indisponivel', { ids: sairam });
  if (voltaram.length) publish(tenantId, 'produto.disponivel', { ids: voltaram });
}
