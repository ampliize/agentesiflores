// API da Equipe dos Sonhos (v1). Independente de framework: o servidor Express e a demo no
// navegador chamam handle() com a loja já autenticada.
import { db } from './store.js';
import { AGENTS, AGENT_KEYS, getConfig, saveConfig, hired, active, setHired, getTenant } from './team.js';
import { listActivity, currentWork, log } from './events.js';
import { createTask, listTasks, updateTask, getTask } from './tasks.js';
import { listProducts, listInsumos, getSettings, insumoMap, composicaoTexto, disponibilidade, listChanges, undoChange, getProduct, applyChanges } from './catalog.js';
import { analisarProduto, precoSugerido, impactoDesconto, margens, resumoPeriodo, diagnosticoMargem, params } from './finance.js';
import { listOrders, confirmarPagamento, getOrder, topPerguntas, periodo } from './orders.js';
import * as alex from './agents/alex.js';
import * as sol from './agents/sol.js';
import * as flora from './agents/flora.js';
import * as mari from './agents/mari.js';
import * as caio from './agents/caio.js';
import { executar } from './agents/alex-actions.js';
import { aiEnabled, MODEL } from './llm.js';
import { localDate, addDays, round2, now } from './util.js';
import { rotinas } from './index.js';

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const nf = (m = 'Não encontrado') => new HttpError(404, m);
const own = (doc, t) => { if (!doc || doc.tenant_id !== t) throw nf(); return doc; };
const agente = (a) => { if (!AGENT_KEYS.includes(a)) throw nf('Agente inválido'); return a; };

function publicTenant(t) {
  const mask = (s) => (s ? `${String(s).slice(0, 4)}••••` : '');
  return { id: t.id, name: t.name, demo: !!t.demo, plano: t.plano, api_key_prefix: t.api_key_prefix,
    iflores: { ...t.iflores, token: mask(t.iflores?.token) },
    integrations: Object.fromEntries(Object.entries(t.integrations || {}).map(([k, v]) => [k, { ...v, access_token: mask(v.access_token) }])),
    webhook: { ...t.webhook, secret: mask(t.webhook?.secret) } };
}

function equipe(t) {
  const dia = new Date(Date.now() - 864e5).toISOString();
  const atv = db().list('activity', t, (a) => a.created_at >= dia);
  const abertas = listTasks(t).filter((x) => ['aberta', 'em_andamento', 'aguardando_dono'].includes(x.status));
  return AGENT_KEYS.map((k) => {
    const last = listActivity(t, { agent: k, limit: 1 })[0];
    const trab = currentWork(t, k);
    return { key: k, ...AGENTS[k], contratado: hired(t, k), ativo: active(t, k),
      status: !hired(t, k) ? 'nao_contratado' : !getConfig(t, k).enabled ? 'pausado' : trab ? 'trabalhando' : 'online',
      agora: trab || last?.message || 'Aguardando a próxima tarefa', ultima: last?.created_at || null,
      acoes_24h: atv.filter((a) => a.agent === k && a.kind === 'acao').length, sugestoes_24h: atv.filter((a) => a.agent === k && a.kind === 'sugestao').length,
      pendentes: abertas.filter((x) => x.responsavel === k).length };
  });
}

function resultados(t) {
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const atv = db().list('activity', t, (a) => a.created_at >= desde);
  const cnt = (agent, type) => atv.filter((a) => a.agent === agent && (!type || a.type === type)).length;
  const pedidosFlora = listOrders(t, (o) => o.origem === 'flora' && o.created_at >= desde);
  const pagos = pedidosFlora.filter((o) => o.pagamento.status === 'confirmado');
  const convs = db().list('conversations', t, (c) => (c.ultima_cliente_em || '') >= desde);
  const posts = db().list('posts', t, (p) => p.created_at >= desde);
  const cs = caio.listCampaigns(t); const gasto = cs.reduce((s, c) => s + c.metricas.gasto, 0); const receita = cs.reduce((s, c) => s + c.metricas.receita, 0);
  const changes = listChanges(t).filter((c) => c.created_at >= desde);
  const recs = listTasks(t, { tipo: 'recomendacao' });
  const minutos = { flora: convs.length * 6, mari: posts.length * 25, caio: cnt('caio', 'analise') * 30 + cnt('caio', 'campanha') * 10, alex: changes.length * 4 + cnt('alex', 'resumo') * 15, sol: db().get('chats', `${t}:sol`)?.mensagens?.filter((m) => m.role === 'user').length * 10 || 0 };
  return {
    periodo: '30 dias',
    agentes: {
      flora: { conversas: convs.length, pedidos_criados: pedidosFlora.length, valor_pedidos: round2(pedidosFlora.reduce((s, o) => s + o.total, 0)), pagos_confirmados: pagos.length, valor_pago: round2(pagos.reduce((s, o) => s + o.total, 0)), recuperacoes_enviadas: cnt('flora', 'recuperacao'), encaminhadas_para_pessoa: cnt('flora', 'transferencia') },
      mari: { pecas_criadas: posts.length, publicadas: posts.filter((p) => p.status === 'publicado').length, aguardando: posts.filter((p) => p.status === 'aguardando_aprovacao').length, pausadas_por_indisponibilidade: posts.filter((p) => p.status === 'pausado_indisponivel').length },
      caio: { gasto_7d: round2(gasto), compras_identificaveis: cs.reduce((s, c) => s + c.metricas.compras, 0), receita_identificavel: round2(receita), roas: gasto ? round2(receita / gasto) : 0, pausas: atv.filter((a) => a.agent === 'caio' && /Pausou/.test(a.message)).length, teto_diario: getConfig(t, 'caio').teto_diario },
      alex: { alteracoes: changes.length, desfeitas: changes.filter((c) => c.revertida).length, recomendacoes: recs.length, recomendacoes_executadas: recs.filter((r) => r.status === 'concluida').length, revisadas: recs.filter((r) => r.revisada).length },
      sol: { consultas: db().get('chats', `${t}:sol`)?.mensagens?.filter((m) => m.role === 'user').length || 0 },
    },
    tempo_economizado_horas: round2(Object.values(minutos).reduce((s, x) => s + x, 0) / 60),
    tempo_por_agente_horas: Object.fromEntries(Object.entries(minutos).map(([k, v]) => [k, round2(v / 60)])),
    avisos: [
      'O tempo economizado é uma estimativa (minutos médios por tarefa) para a fase de validação.',
      'Pedidos da Flora e compras identificáveis dos anúncios são resultados diretos; o crescimento total da loja não é atribuído automaticamente aos agentes.',
      'Para uma cobrança por desempenho, ainda precisamos definir com o lojista o que conta como resultado, como descontar sazonalidade, cancelamentos, reembolsos e investimento em mídia.',
    ],
  };
}

function produtoView(t, p, s, imap) {
  const a = analisarProduto(t, p);
  return { ...p, disponivel: disponibilidade(p, s), composicao_texto: composicaoTexto(p, imap), margem: { cmv: a.cmv, mc: a.mc, mc_pct: a.mc_pct, resultado: a.resultado, parcial: a.parcial, faltando: a.faltando }, fotos: db().list('photos', t, (f) => f.produto_id === p.id).length };
}

async function aprovarTarefa(t, task) {
  if (task.tipo === 'recomendacao') return alex.executarRecomendacao(t, task.id);
  let r = { texto: 'Concluída.' };
  if (task.acao && task.responsavel === 'caio') r = caio.executarAprovado(t, task.acao.acao, task.acao.params);
  else if (task.acao && task.responsavel === 'alex') r = executar(t, task.acao.acao, task.acao.params, { confirmado: true, comando: task.titulo });
  updateTask(task.id, { status: 'concluida', resultado: r.texto, executada_em: now() }, 'dono');
  return r;
}

const routes = [];
const on = (method, path, fn) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn]);

on('GET', '/me', ({ t }) => ({ tenant: publicTenant(getTenant(t)), ai: { enabled: aiEnabled(), model: aiEnabled() ? MODEL() : null }, hoje: localDate() }));
on('GET', '/equipe', ({ t }) => {
  const sem = alex.relatorioSemanal(t);
  return { equipe: equipe(t), semana: { faturamento: sem.atual.faturamento, pedidos: sem.atual.pedidos, ticket: sem.atual.ticket, conversao: sem.atual.conversao, variacoes: sem.variacoes },
    pendencias: listTasks(t).filter((x) => x.status === 'aguardando_dono').length, resumo: db().list('reports', t, (r) => r.agent === 'alex').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null, ai: aiEnabled() };
});
on('GET', '/atividade', ({ t, q }) => listActivity(t, { limit: Math.min(200, Number(q.limit) || 60), agent: q.agente }));
on('GET', '/resultados', ({ t }) => resultados(t));

// tarefas
on('GET', '/tarefas', ({ t, q }) => listTasks(t, { status: q.status, responsavel: q.responsavel, tipo: q.tipo }));
on('POST', '/tarefas', ({ t, b }) => { if (!b?.titulo || !AGENT_KEYS.includes(b.responsavel)) throw new HttpError(400, 'Informe responsável e título'); return createTask(t, { responsavel: b.responsavel, titulo: b.titulo, prioridade: b.prioridade, solicitante: 'dono', tipo: 'pedido' }); });
on('PATCH', '/tarefas/:id', ({ t, p, b }) => { own(getTask(p.id), t); return updateTask(p.id, { status: b.status, resultado: b.resultado ?? undefined }, 'dono'); });
on('POST', '/tarefas/:id/aprovar', async ({ t, p }) => aprovarTarefa(t, own(getTask(p.id), t)));
on('POST', '/tarefas/:id/recusar', ({ t, p }) => { own(getTask(p.id), t); return updateTask(p.id, { status: 'recusada', resultado: 'Recusada pelo dono' }, 'dono'); });

// agentes
on('GET', '/agentes/:a/config', ({ t, p }) => getConfig(t, agente(p.a)));
on('PUT', '/agentes/:a/config', ({ t, p, b }) => { const c = saveConfig(t, agente(p.a), b); log(t, p.a, `Configuração de ${AGENTS[p.a].nome} atualizada pelo dono`, { type: 'config' }); return c; });
on('POST', '/agentes/:a/contratar', ({ t, p, b }) => { agente(p.a); const r = setHired(t, p.a, b?.contratado !== false); log(t, p.a, `${AGENTS[p.a].nome} ${b?.contratado !== false ? 'contratado(a)' : 'removido(a) do plano'}`, { type: 'plano' }); return r; });
on('GET', '/agentes/:a/chat', ({ t, p }) => alex.getChat(t, agente(p.a)).mensagens);
on('POST', '/agentes/:a/conversar', async ({ t, p, b }) => {
  const a = agente(p.a); if (!b?.texto) throw new HttpError(400, 'Escreva uma mensagem');
  if (a === 'alex') return alex.conversar(t, b.texto);
  if (a === 'sol') return sol.conversar(t, b.texto);
  if (a === 'flora') throw new HttpError(400, 'A Flora conversa com os clientes: use o simulador em Atendimento');
  if (!active(t, a)) return { texto: `${AGENTS[a].nome} não está contratado(a) ou está pausado(a).` };
  const chat = alex.getChat(t, a); chat.mensagens.push({ role: 'user', texto: b.texto, em: now() });
  const task = createTask(t, { responsavel: a, solicitante: 'dono', tipo: 'pedido', titulo: b.texto.slice(0, 140) });
  const texto = a === 'mari' ? 'Anotado! Coloquei na minha lista de tarefas e preparo a peça para a sua aprovação.' : 'Anotado! Vou considerar isso na próxima análise das campanhas e te trago uma proposta para aprovar.';
  if (a === 'mari') { mari.planejarSemana(t, { motivo: `pedido do dono: ${b.texto}` }).then(() => updateTask(task.id, { status: 'concluida', resultado: 'Peças criadas em Conteúdo.' })).catch(() => {}); }
  if (a === 'caio') { caio.analisar(t, { motivo: `pedido do dono: ${b.texto}` }).then(() => updateTask(task.id, { status: 'concluida', resultado: 'Propostas em Tarefas.' })).catch(() => {}); }
  chat.mensagens.push({ role: 'assistant', texto, em: now() }); alex.saveChat(chat);
  return { texto };
});
on('POST', '/agentes/:a/executar', async ({ t, p }) => {
  const a = agente(p.a); if (!active(t, a)) throw new HttpError(409, `${AGENTS[a].nome} não está ativo(a)`);
  if (a === 'alex') return alex.rotina(t);
  if (a === 'mari') return { pecas: (await mari.planejarSemana(t, { motivo: 'acionado pelo dono' })).length };
  if (a === 'caio') return caio.analisar(t, { motivo: 'acionado pelo dono' });
  if (a === 'flora') return flora.rotina(t);
  return { ok: true };
});
on('POST', '/rotinas', async ({ t }) => ({ feitos: await rotinas(t, { forcar: true }) }));

// loja (Alex)
on('GET', '/loja/produtos', ({ t }) => { const s = getSettings(t); const im = insumoMap(t); return listProducts(t).map((p) => produtoView(t, p, s, im)); });
on('GET', '/loja/insumos', ({ t }) => listInsumos(t));
on('GET', '/loja/configuracoes', ({ t }) => getSettings(t));
on('GET', '/loja/alteracoes', ({ t }) => listChanges(t).slice(0, 100).map(({ ops, ...c }) => ({ ...c, itens: ops.length })));
on('POST', '/loja/alteracoes/:id/desfazer', ({ t, p }) => undoChange(t, p.id, 'dono'));
on('POST', '/loja/acao', ({ t, b }) => executar(t, b.acao, b.params, { comando: 'painel', confirmado: true }));
on('GET', '/alex/resumo', ({ t }) => alex.resumoDiario(t));
on('GET', '/alex/semana', ({ t }) => alex.relatorioSemanal(t));
on('GET', '/alex/compras', ({ t }) => alex.sugestaoCompras(t));
on('GET', '/alex/recomendacoes', ({ t }) => { alex.registrarRecomendacoes(t); return listTasks(t, { tipo: 'recomendacao' }); });

// finanças (Sol)
on('GET', '/financas', ({ t }) => { const P = params(t); return { config: getConfig(t, 'sol'), custos_fixos_total: P.fixos, variaveis_pct: P.varPct, margens: margens(t), resumo: resumoPeriodo(t), diagnostico: diagnosticoMargem(t) }; });
on('PUT', '/financas', ({ t, b }) => saveConfig(t, 'sol', b));
on('POST', '/financas/preco', ({ t, b }) => { const r = precoSugerido(t, { custo: Number(b.custo), margemAlvoPct: b.margem_alvo_pct != null ? Number(b.margem_alvo_pct) : undefined }); return { ...r, texto: sol.textoPreco(r) }; });
on('POST', '/financas/desconto', ({ t, b }) => { const d = impactoDesconto(t, { produto: own(getProduct(b.produto_id), t), descontoPct: Number(b.desconto_pct) }); return { ...d, texto: sol.textoDesconto(d) }; });
on('PUT', '/insumos/:id', ({ t, p, b }) => { const i = own(db().get('insumos', p.id), t); return db().put('insumos', { ...i, ...Object.fromEntries(['custo', 'estoque', 'perda_pct', 'compra_prevista'].filter((k) => b[k] !== undefined).map((k) => [k, b[k] === '' || b[k] == null ? null : Number(b[k])])) }); });
on('PUT', '/produtos/:id/custo', ({ t, p, b }) => { const pr = own(getProduct(p.id), t); applyChanges(t, { actor: 'sol', descricao: `Custo de ${pr.nome} atualizado`, ops: [{ coll: 'products', id: pr.id, after: { ...pr, custo_informado: b.custo_informado === '' ? null : Number(b.custo_informado) } }] }); return analisarProduto(t, getProduct(p.id)); });

// atendimento (Flora)
on('GET', '/atendimento/conversas', ({ t }) => db().list('conversations', t).sort((a, b) => ((a.updated_at || '') < (b.updated_at || '') ? 1 : -1)).map((c) => ({ ...c, ultima: flora.listMessages(c.id).slice(-1)[0] || null })));
on('GET', '/atendimento/conversas/:id', ({ t, p }) => { const c = own(db().get('conversations', decodeURIComponent(p.id)), t); return { conversa: c, mensagens: flora.listMessages(c.id), pedidos: listOrders(t, (o) => o.contato === c.contato) }; });
on('POST', '/atendimento/mensagem', ({ t, b }) => { if (!b?.texto) throw new HttpError(400, 'texto é obrigatório'); return flora.receberMensagem(t, { canal: b.canal || 'chat_loja', contato: b.contato || `visitante_${Date.now()}`, nome: b.nome, texto: b.texto }); });
on('POST', '/atendimento/conversas/:id/assumir', async ({ t, p, b }) => flora.mensagemFuncionario(t, decodeURIComponent(p.id), b?.texto || 'Oi! Aqui é da equipe da loja, vou continuar seu atendimento.'));
on('POST', '/atendimento/conversas/:id/devolver', ({ t, p }) => { flora.devolverParaFlora(t, decodeURIComponent(p.id)); return { ok: true }; });
on('GET', '/pedidos', ({ t }) => listOrders(t).slice(0, 100));
on('POST', '/pedidos/:id/simular-pagamento', ({ t, p }) => { if (!getTenant(t).demo) throw new HttpError(403, 'Disponível só na demonstração; em lojas reais o pagamento é confirmado pelo sistema.'); return confirmarPagamento(t, p.id, 'simulação da demonstração'); });

// conteúdo (Mari)
on('GET', '/conteudo/posts', ({ t, q }) => mari.listPosts(t, q.status));
on('POST', '/conteudo/aprovar', ({ t, b }) => mari.aprovar(t, b.ids || []));
on('POST', '/conteudo/posts/:id/ajustar', ({ t, p, b }) => { own(mari.getPost(p.id), t); return mari.ajustar(t, p.id, b.pedido || ''); });
on('POST', '/conteudo/posts/:id/descartar', ({ t, p }) => { own(mari.getPost(p.id), t); mari.descartar(t, p.id); return { ok: true }; });
on('POST', '/conteudo/posts/:id/publicar-agora', async ({ t, p }) => { const po = own(mari.getPost(p.id), t); db().put('posts', { ...po, status: 'agendado', scheduled_at: new Date().toISOString() }); await mari.publicarDevidos(t); return mari.getPost(p.id); });
on('GET', '/conteudo/fotos', ({ t }) => mari.listPhotos(t));
on('POST', '/conteudo/fotos', ({ t, b }) => mari.addPhoto(t, b));
on('DELETE', '/conteudo/fotos/:id', ({ t, p }) => { mari.removePhoto(t, p.id); return { ok: true }; });

// anúncios (Caio)
on('GET', '/anuncios', ({ t }) => ({ campanhas: caio.listCampaigns(t).map((c) => ({ ...c, produtos: (c.produto_ids || []).map((id) => getProduct(id)?.nome) })), config: getConfig(t, 'caio'), verba_teste: caio.verbaTeste(t), ultima_analise: db().list('reports', t, (r) => r.agent === 'caio').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null, mari_contratada: active(t, 'mari') }));
on('POST', '/anuncios/:id/pausar', ({ t, p }) => { caio.pausarManual(t, p.id); return { ok: true }; });

// eventos vindos da iFlores
on('POST', '/eventos', ({ t, b }) => {
  const { type, data = {} } = b || {};
  if (type === 'payment.confirmed') return confirmarPagamento(t, data.order_id, 'sistema');
  if (type === 'order.status') { const o = own(getOrder(data.order_id), t); return db().put('orders', { ...o, status: data.status }); }
  if (type === 'customer.optout') { flora.optout(t, data.contato); return { ok: true }; }
  log(t, 'alex', `Evento recebido da iFlores: ${type}`, { type: 'evento', data });
  return { ok: true };
});

// integrações
on('PUT', '/integracoes/:nome', ({ t, p, b }) => {
  const tn = getTenant(t); const nome = p.nome;
  if (!['iflores', 'whatsapp', 'meta_ads', 'google_ads', 'instagram'].includes(nome)) throw nf('Integração inválida');
  const limpo = Object.fromEntries(Object.entries(b || {}).filter(([, v]) => !String(v).includes('••••')));
  const upd = nome === 'iflores' ? { ...tn, iflores: { ...tn.iflores, ...limpo, connected: !!(limpo.base_url && (limpo.token || tn.iflores?.token)) } } : { ...tn, integrations: { ...tn.integrations, [nome]: { ...tn.integrations[nome], ...limpo, connected: true } } };
  if (tn.demo) return { ok: false, mensagem: 'Na demonstração as integrações não conectam de verdade. Na loja instalada, este passo valida o acesso na hora.', tenant: publicTenant(tn) };
  db().put('tenants', upd);
  log(t, 'alex', `Integração ${nome} configurada`, { type: 'integracao' });
  return { ok: true, tenant: publicTenant(upd) };
});

export async function handle({ method, path, query = {}, body = null, tenantId }) {
  for (const [m, re, fn] of routes) {
    const match = path.match(re);
    if (match && m === method) {
      try { return { status: 200, body: (await fn({ t: tenantId, p: match.groups || {}, q: query, b: body || {} })) ?? { ok: true } }; }
      catch (e) { if (e.status) return { status: e.status, body: { error: e.message } }; console.error(e); return { status: 500, body: { error: e.message || 'Erro interno' } }; }
    }
  }
  return { status: 404, body: { error: 'Rota não encontrada' } };
}

export { periodo, topPerguntas, addDays };
