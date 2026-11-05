// Tarefas: criadas pelo dono, pelo Gerente ou por outros agentes. Status: todo | doing | review | done | cancelled
import { get, all, run, uid, now } from '../db.js';
import { logActivity } from './events.js';

export function createTask(tenantId, { agent, title, priority = 'normal', created_by = 'dono', status = 'todo', due_at = null, data = {} }) {
  // evita duplicar tarefas abertas idênticas
  const dup = get("SELECT id FROM tasks WHERE tenant_id = ? AND agent = ? AND title = ? AND status IN ('todo','doing','review')", tenantId, agent, title);
  if (dup) return getTask(dup.id);
  const id = uid('task_');
  run('INSERT INTO tasks (id, tenant_id, agent, title, status, priority, created_by, data, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, tenantId, agent, title, status, priority, created_by, JSON.stringify(data), due_at, now(), now());
  logActivity(tenantId, created_by === 'dono' ? agent : created_by, 'tarefa_criada', `Nova tarefa para ${agent}: ${title}`, { task_id: id });
  return getTask(id);
}

export const getTask = (id) => get('SELECT * FROM tasks WHERE id = ?', id);

export function listTasks(tenantId, { status, agent } = {}) {
  let sql = 'SELECT * FROM tasks WHERE tenant_id = ?'; const p = [tenantId];
  if (status) { sql += ' AND status = ?'; p.push(status); }
  if (agent) { sql += ' AND agent = ?'; p.push(agent); }
  return all(sql + ' ORDER BY created_at DESC LIMIT 300', ...p);
}

export function updateTask(id, patch) {
  const t = getTask(id); if (!t) return null;
  const { id: _i, tenant_id, agent, title, status, priority, created_by, due_at, created_at, updated_at, ...data } = t;
  const next = { agent, title, status, priority, due_at, ...patch };
  const extra = { ...data, ...(patch.data || {}) };
  run('UPDATE tasks SET agent = ?, title = ?, status = ?, priority = ?, due_at = ?, data = ?, updated_at = ? WHERE id = ?',
    next.agent, next.title, next.status, next.priority, next.due_at, JSON.stringify(extra), now(), id);
  return getTask(id);
}
