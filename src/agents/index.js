// Orquestração: executar um agente sob demanda e processar a fila de tarefas.
import { getTenant, getAgentConfig } from '../lib/tenants.js';
import { listTasks, updateTask } from '../lib/tasks.js';
import { logActivity } from '../lib/events.js';
import { aiEnabled, structured } from '../lib/llm.js';
import { IFloresClient } from '../integrations/iflores.js';
import * as social from './social.js';
import * as trafego from './trafego.js';
import * as gerente from './gerente.js';

export { AGENTS, AGENT_KEYS } from './defaults.js';

export async function runAgent(tenantId, agent, opts = {}) {
  switch (agent) {
    case 'gerente': return gerente.supervise(tenantId, { sendReport: !!opts.sendReport, reason: opts.reason || 'execução manual' });
    case 'trafego': return trafego.analyze(tenantId, { reason: opts.reason || 'execução manual' });
    case 'social': return social.planWeek(tenantId, { reason: opts.reason || 'execução manual', extra: opts.extra || '' });
    case 'atendente': return { info: 'A Atendente trabalha em tempo real a cada mensagem recebida no WhatsApp.' };
    default: throw new Error('Agente inválido');
  }
}

/** Uma peça avulsa a partir de uma tarefa (ex.: "Post sobre orquídeas para o Dia das Mães"). */
async function socialFromTask(tenantId, task) {
  const tenant = getTenant(tenantId); const cfg = getAgentConfig(tenantId, 'social');
  const products = await new IFloresClient(tenant).listProducts();
  const formato = /stor/i.test(task.title) ? 'story' : /an[uú]ncio|criativo|campanha/i.test(task.title) ? 'anuncio' : 'feed';
  let p;
  if (aiEnabled()) {
    p = await structured({
      system: `Você é ${cfg.nome_exibicao}, social media de floricultura. Tom: ${cfg.tom}.`,
      prompt: `Crie UMA peça (${formato}) para a tarefa: "${task.title}". Loja: ${tenant.name}. Catálogo: ${products.map((x) => `${x.id}: ${x.nome} R$${x.preco}`).join('; ')}. Hashtags fixas: ${cfg.hashtags_fixas.join(' ')}.`,
      schema: { type: 'object', additionalProperties: false, required: ['tema', 'produto_id', 'titulo_arte', 'subtitulo_arte', 'cta', 'mostrar_preco', 'legenda', 'hashtags', 'layout'], properties: { tema: { type: 'string' }, produto_id: { type: ['string', 'null'] }, titulo_arte: { type: 'string' }, subtitulo_arte: { type: 'string' }, cta: { type: 'string' }, mostrar_preco: { type: 'boolean' }, legenda: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } }, layout: { type: 'string', enum: ['classico', 'destaque', 'minimal'] } } },
      effort: 'low',
    });
  } else {
    const prod = products[0];
    p = { tema: task.title, produto_id: prod.id, titulo_arte: task.title.split(/[:—-]/)[0].split(' ').slice(0, 5).join(' '), subtitulo_arte: `${prod.nome} com entrega no mesmo dia`, cta: 'Peça pelo WhatsApp', mostrar_preco: true, legenda: `${task.title}\n\nChame no WhatsApp! 💐`, hashtags: cfg.hashtags_fixas, layout: 'destaque' };
  }
  const prod = products.find((x) => x.id === p.produto_id);
  const scheduled = formato === 'anuncio' ? null : new Date(Date.now() + 3 * 3600e3).toISOString();
  return social.createPost(tenant, cfg, { ...p, formato, produto: prod ? { id: prod.id, nome: prod.nome, preco: prod.preco } : null, scheduled_at: scheduled });
}

/** Processa tarefas "todo" dos agentes (do dono, do Gerente ou entre agentes). */
export async function processTasks(tenantId, max = 3) {
  const todo = listTasks(tenantId, { status: 'todo' }).filter((t) => ['social', 'trafego'].includes(t.agent)).slice(0, max);
  for (const task of todo) {
    if (!getAgentConfig(tenantId, task.agent).enabled) continue;
    updateTask(task.id, { status: 'doing' });
    try {
      if (task.agent === 'social') {
        const post = await socialFromTask(tenantId, task);
        updateTask(task.id, { status: 'done', data: { resultado: { post_id: post.id } } });
        logActivity(tenantId, 'social', 'tarefa_concluida', `Concluiu: ${task.title}`, { task_id: task.id, post_id: post.id }, 'success');
      } else {
        await trafego.analyze(tenantId, { reason: `tarefa: ${task.title}` });
        updateTask(task.id, { status: 'done' });
        logActivity(tenantId, 'trafego', 'tarefa_concluida', `Concluiu: ${task.title}`, { task_id: task.id }, 'success');
      }
    } catch (err) {
      updateTask(task.id, { status: 'todo', data: { erro: err.message } });
      logActivity(tenantId, task.agent, 'erro', `Falha na tarefa "${task.title}": ${err.message}`, { task_id: task.id }, 'error');
    }
  }
}
