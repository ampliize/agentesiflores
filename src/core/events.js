// Feed de atividades + eventos de domínio entre agentes (base compartilhada).
// `kind` distingue o que foi EXECUTADO ('acao') do que foi apenas SUGERIDO ('sugestao').
import { db, comLoja } from './store.js';
import { uid, now } from './util.js';

class Emitter {
  constructor() { this.l = new Map(); }
  on(ev, fn) { if (!this.l.has(ev)) this.l.set(ev, new Set()); this.l.get(ev).add(fn); return () => this.l.get(ev)?.delete(fn); }
  off(ev, fn) { this.l.get(ev)?.delete(fn); }
  emit(ev, data) {
    const reacoes = [];
    for (const fn of [...(this.l.get(ev) || [])]) {
      try {
        const r = fn(data);
        if (r && typeof r.then === 'function') reacoes.push(r.catch((e) => console.error(`[evento ${ev}]`, e)));
      } catch (e) { console.error(`[evento ${ev}]`, e); }
    }
    return reacoes;
  }
}
export const bus = new Emitter();      // tempo real para o painel (SSE)
export const domain = new Emitter();   // eventos de negócio entre agentes

const status = new Map();

/** Gravação de atividade: enfileirada por loja e feita dentro do contexto dela. Não bloqueia quem chama. */
const gravacoes = new Map();
export function log(tenantId, agent, message, { type = 'info', level = 'info', kind = 'info', data = {} } = {}) {
  const item = { id: uid('act_'), tenant_id: tenantId, agent, type, level, kind, message, data, created_at: now() };
  const anterior = gravacoes.get(tenantId) || Promise.resolve();
  const atual = anterior.then(() => comLoja(tenantId, () => db().put('activity', item))).catch((e) => console.error(`[atividade ${tenantId}]`, e.message));
  gravacoes.set(tenantId, atual);
  bus.emit(`t:${tenantId}`, { kind: 'activity', item });
  bus.emit('webhook', { tenantId, event: `agent.${type}`, payload: item });
  return item;
}
/** Espera as gravações pendentes de uma loja (usado por testes e antes de respostas que mostram o feed). */
export const esperarAtividades = (tenantId) => gravacoes.get(tenantId) || Promise.resolve();

export async function listActivity(tenantId, { limit = 60, agent } = {}) {
  await esperarAtividades(tenantId);
  return (await db().list('activity', tenantId, (a) => !agent || a.agent === agent))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit);
}

/** Marca um agente como "trabalhando" enquanto `fn` roda. */
export async function working(tenantId, agent, current, fn) {
  status.set(`${tenantId}:${agent}`, current);
  bus.emit(`t:${tenantId}`, { kind: 'status', agent, status: 'trabalhando', current });
  try { return await fn(); } finally {
    status.delete(`${tenantId}:${agent}`);
    bus.emit(`t:${tenantId}`, { kind: 'status', agent, status: 'online', current: '' });
  }
}
export const currentWork = (tenantId, agent) => status.get(`${tenantId}:${agent}`) || '';

/** Reações dos agentes ainda em andamento, por loja. Respostas da API esperam por elas. */
const reacoesPendentes = new Map();
/** Emite um evento de domínio (ex.: 'produto.indisponivel') para os outros agentes reagirem. */
export function publish(tenantId, event, data) {
  const novas = domain.emit(event, { tenantId, ...data });
  if (novas.length) reacoesPendentes.set(tenantId, [...(reacoesPendentes.get(tenantId) || []), ...novas]);
}
/** Espera as reações pendentes de uma loja (antes de responder algo que mostra o resultado delas). */
export async function esperarReacoes(tenantId) {
  while (reacoesPendentes.get(tenantId)?.length) {
    const lista = reacoesPendentes.get(tenantId); reacoesPendentes.set(tenantId, []);
    await Promise.all(lista);
  }
}
