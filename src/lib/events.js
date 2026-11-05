// Log de atividades + barramento em tempo real (SSE) para o monitoramento do painel.
import { EventEmitter } from 'node:events';
import { run, all, uid, now } from '../db.js';
import { dispatchWebhook } from './webhooks-out.js';

export const bus = new EventEmitter();
bus.setMaxListeners(1000);

/**
 * Registra uma atividade de agente. Aparece no feed do painel e é enviada ao
 * webhook de saída da loja (se configurado).
 */
export function logActivity(tenantId, agent, type, message, data = {}, level = 'info') {
  const item = { id: uid('act_'), tenant_id: tenantId, agent, type, level, message, data, created_at: now() };
  run(
    'INSERT INTO activity (id, tenant_id, agent, type, level, message, data, created_at) VALUES (?,?,?,?,?,?,?,?)',
    item.id, tenantId, agent, type, level, message, JSON.stringify(data), item.created_at,
  );
  bus.emit(`tenant:${tenantId}`, { kind: 'activity', item });
  dispatchWebhook(tenantId, `agent.${type}`, item).catch(() => {});
  return item;
}

export function setAgentStatus(tenantId, agent, status, current = '') {
  bus.emit(`tenant:${tenantId}`, { kind: 'status', agent, status, current, at: now() });
  agentStatus.set(`${tenantId}:${agent}`, { status, current, at: now() });
}
const agentStatus = new Map();
export const getAgentStatus = (tenantId, agent) =>
  agentStatus.get(`${tenantId}:${agent}`) || { status: 'ocioso', current: '', at: null };

export function listActivity(tenantId, { limit = 50, agent } = {}) {
  return agent
    ? all('SELECT * FROM activity WHERE tenant_id = ? AND agent = ? ORDER BY created_at DESC LIMIT ?', tenantId, agent, limit)
    : all('SELECT * FROM activity WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', tenantId, limit);
}
