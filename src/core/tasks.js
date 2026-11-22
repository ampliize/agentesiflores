// Tarefas registradas entre agentes e com o dono, com responsável, status e resultado.
// tipo:  'sugestao'     → proposta que precisa de aprovação/decisão (nada foi feito ainda)
//        'acao'         → algo que foi executado (registro)
//        'pedido'       → um agente pediu algo a outro
//        'recomendacao' → recomendação do Alex com hipótese e data de revisão
// status: aberta | em_andamento | aguardando_dono | concluida | recusada
import { db } from './store.js';
import { uid, now } from './util.js';
import { log } from './events.js';

export async function createTask(tenantId, { responsavel, titulo, tipo = 'pedido', solicitante = 'dono', status, prioridade = 'normal', detalhes = '', acao = null, extra = {} }) {
  const aberta = ['aberta', 'em_andamento', 'aguardando_dono'];
  const dup = (await db().list('tasks', tenantId, (t) => t.responsavel === responsavel && t.titulo === titulo && aberta.includes(t.status)))[0];
  if (dup) return dup;
  const st = status || (tipo === 'sugestao' || tipo === 'recomendacao' ? 'aguardando_dono' : tipo === 'acao' ? 'concluida' : 'aberta');
  const task = await db().put('tasks', { id: uid('tsk_'), tenant_id: tenantId, responsavel, solicitante, titulo, tipo, status: st, prioridade, detalhes, acao, resultado: null, historico: [{ em: now(), status: st, por: solicitante }], ...extra });
  if (tipo !== 'acao') log(tenantId, solicitante === 'dono' ? responsavel : solicitante, `${tipo === 'sugestao' ? 'Sugeriu' : tipo === 'recomendacao' ? 'Recomendou' : 'Pediu a ' + responsavel}: ${titulo}`, { type: 'tarefa', kind: tipo === 'pedido' ? 'info' : 'sugestao', data: { task_id: task.id } });
  return task;
}

export const getTask = (id) => db().get('tasks', id);

export async function updateTask(id, patch, por = 'sistema') {
  const t = await getTask(id); if (!t) return null;
  const historico = patch.status && patch.status !== t.status ? [...(t.historico || []), { em: now(), status: patch.status, por }] : t.historico;
  return db().put('tasks', { ...t, ...patch, historico });
}

export async function listTasks(tenantId, { status, responsavel, tipo } = {}) {
  return (await db().list('tasks', tenantId, (t) => (!status || t.status === status) && (!responsavel || t.responsavel === responsavel) && (!tipo || t.tipo === tipo)))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
