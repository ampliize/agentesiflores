// Feed de atividades + eventos de domínio entre agentes (base compartilhada).
// `kind` distingue o que foi EXECUTADO ('acao') do que foi apenas SUGERIDO ('sugestao').
import { db } from './store.js';
import { uid, now } from './util.js';

class Emitter {
  constructor() { this.l = new Map(); }
  on(ev, fn) { if (!this.l.has(ev)) this.l.set(ev, new Set()); this.l.get(ev).add(fn); return () => this.l.get(ev)?.delete(fn); }
  off(ev, fn) { this.l.get(ev)?.delete(fn); }
  emit(ev, data) { for (const fn of [...(this.l.get(ev) || [])]) { try { fn(data); } catch (e) { console.error(`[evento ${ev}]`, e); } } }
}
export const bus = new Emitter();      // tempo real para o painel (SSE)
export const domain = new Emitter();   // eventos de negócio entre agentes

const status = new Map();

export function log(tenantId, agent, message, { type = 'info', level = 'info', kind = 'info', data = {} } = {}) {
  const item = { id: uid('act_'), tenant_id: tenantId, agent, type, level, kind, message, data, created_at: now() };
  db().put('activity', item);
  bus.emit(`t:${tenantId}`, { kind: 'activity', item });
  bus.emit('webhook', { tenantId, event: `agent.${type}`, payload: item });
  return item;
}

export function listActivity(tenantId, { limit = 60, agent } = {}) {
  return db().list('activity', tenantId, (a) => !agent || a.agent === agent)
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

/** Emite um evento de domínio (ex.: 'produto.indisponivel') para os outros agentes reagirem. */
export function publish(tenantId, event, data) { domain.emit(event, { tenantId, ...data }); }
