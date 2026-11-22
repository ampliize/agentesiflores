// API da Equipe dos Sonhos (v1). Independente de framework: o servidor Express e a demo no
// navegador chamam handle() com a loja já autenticada.
import { db } from './store.js';
import { AGENTS, AGENT_KEYS, getConfig, saveConfig, hired, active, setHired, getTenant } from './team.js';
import { listActivity, currentWork, log } from './events.js';
import { createTask, listTasks, updateTask, getTask } from './tasks.js';
import { listProducts, listInsumos, getSettings, insumoMap, composicaoTexto, disponibilidade, listChanges, undoChange, getProduct, applyChanges } from './catalog.js';
import { analisarProduto, precoSugerido, impactoDesconto, margens, resumoPeriodo, diagnosticoMargem, params } from './finance.js';
import { listOrders, confirmarPagamento, getOrder, periodo, mudarStatus } from './orders.js';
import * as crm from './crm.js';
import * as aut from './automacoes.js';
import { listarOutbox } from './outbox.js';
import { publish, esperarReacoes } from './events.js';
import * as alex from './agents/alex.js';
import * as sol from './agents/sol.js';
import * as flora from './agents/flora.js';
import * as mari from './agents/mari.js';
import * as caio from './agents/caio.js';
import { executar } from './agents/alex-actions.js';
import { aiEnabled, MODEL } from './llm.js';
import { localDate, round2, now } from './util.js';
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

async function equipe(t) {
  const dia = new Date(Date.now() - 864e5).toISOString();
  const atv = await db().list('activity', t, (a) => a.created_at >= dia);
  const abertas = (await listTasks(t)).filter((x) => ['aberta', 'em_andamento', 'aguardando_dono'].includes(x.status));
  const out = [];
  const floraContratada = await hired(t, 'flora');
  for (const k of AGENT_KEYS.filter((k) => k !== 'flora' || floraContratada)) {
    const last = (await listActivity(t, { agent: k, limit: 1 }))[0];
    const trab = currentWork(t, k);
    const contratado = await hired(t, k);
    const cfg = await getConfig(t, k);
    out.push({ key: k, ...AGENTS[k], contratado, ativo: await active(t, k),
      status: !contratado ? 'nao_contratado' : !cfg.enabled ? 'pausado' : trab ? 'trabalhando' : 'online',
      agora: trab || last?.message || 'Aguardando a próxima tarefa', ultima: last?.created_at || null,
      acoes_24h: atv.filter((a) => a.agent === k && a.kind === 'acao').length, sugestoes_24h: atv.filter((a) => a.agent === k && a.kind === 'sugestao').length,
      pendentes: abertas.filter((x) => x.responsavel === k).length });
  }
  return out;
}

async function resultados(t) {
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const atv = await db().list('activity', t, (a) => a.created_at >= desde);
  const cnt = (agent, type) => atv.filter((a) => a.agent === agent && (!type || a.type === type)).length;
  const pedidosFlora = await listOrders(t, (o) => o.origem === 'flora' && o.created_at >= desde);
  const pagos = pedidosFlora.filter((o) => o.pagamento.status === 'confirmado');
  const convs = await db().list('conversations', t, (c) => (c.ultima_cliente_em || '') >= desde);
  const posts = await db().list('posts', t, (p) => p.created_at >= desde);
  const cs = await caio.listCampaigns(t); const gasto = cs.reduce((s, c) => s + c.metricas.gasto, 0); const receita = cs.reduce((s, c) => s + c.metricas.receita, 0);
  const changes = (await listChanges(t)).filter((c) => c.created_at >= desde);
  const recs = await listTasks(t, { tipo: 'recomendacao' });
  const chatSol = await db().get('chats', `${t}:sol`);
  const perguntasSol = chatSol?.mensagens?.filter((m) => m.role === 'user').length || 0;
  const minutos = { flora: convs.length * 6, mari: posts.length * 25, caio: cnt('caio', 'analise') * 30 + cnt('caio', 'campanha') * 10, alex: changes.length * 4 + cnt('alex', 'resumo') * 15, sol: perguntasSol * 10 };
  const cfgCaio = await getConfig(t, 'caio');
  return {
    periodo: '30 dias',
    agentes: {
      flora: { conversas: convs.length, pedidos_criados: pedidosFlora.length, valor_pedidos: round2(pedidosFlora.reduce((s, o) => s + o.total, 0)), pagos_confirmados: pagos.length, valor_pago: round2(pagos.reduce((s, o) => s + o.total, 0)), recuperacoes_enviadas: cnt('flora', 'recuperacao'), encaminhadas_para_pessoa: cnt('flora', 'transferencia') },
      mari: { pecas_criadas: posts.length, publicadas: posts.filter((p) => p.status === 'publicado').length, aguardando: posts.filter((p) => p.status === 'aguardando_aprovacao').length, pausadas_por_indisponibilidade: posts.filter((p) => p.status === 'pausado_indisponivel').length },
      caio: { gasto_7d: round2(gasto), compras_identificaveis: cs.reduce((s, c) => s + c.metricas.compras, 0), receita_identificavel: round2(receita), roas: gasto ? round2(receita / gasto) : 0, pausas: atv.filter((a) => a.agent === 'caio' && /Pausou/.test(a.message)).length, teto_diario: cfgCaio.teto_diario },
      alex: { alteracoes: changes.length, desfeitas: changes.filter((c) => c.revertida).length, recomendacoes: recs.length, recomendacoes_executadas: recs.filter((r) => r.status === 'concluida').length, revisadas: recs.filter((r) => r.revisada).length },
      sol: { consultas: perguntasSol },
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

async function produtoView(t, p, s, imap) {
  const a = await analisarProduto(t, p);
  const fotos = (await db().list('photos', t, (f) => f.produto_id === p.id)).length;
  return { ...p, disponivel: disponibilidade(p, s), composicao_texto: composicaoTexto(p, imap), margem: { cmv: a.cmv, mc: a.mc, mc_pct: a.mc_pct, resultado: a.resultado, parcial: a.parcial, faltando: a.faltando }, fotos };
}

async function aprovarTarefa(t, task) {
  if (task.tipo === 'recomendacao') return alex.executarRecomendacao(t, task.id);
  let r = { texto: 'Concluída.' };
  if (task.acao && task.responsavel === 'caio') r = await caio.executarAprovado(t, task.acao.acao, task.acao.params);
  else if (task.acao && task.responsavel === 'alex') r = await executar(t, task.acao.acao, task.acao.params, { confirmado: true, comando: task.titulo });
  await updateTask(task.id, { status: 'concluida', resultado: r.texto, executada_em: now() }, 'dono');
  return r;
}

const routes = [];
const on = (method, path, fn) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn]);

on('GET', '/me', async ({ t }) => ({ tenant: publicTenant(await getTenant(t)), ai: { enabled: aiEnabled(), model: aiEnabled() ? MODEL() : null }, hoje: localDate() }));
on('GET', '/equipe', async ({ t }) => {
  const sem = await alex.relatorioSemanal(t);
  const abertas = await listTasks(t);
  const resumo = (await db().list('reports', t, (r) => r.agent === 'alex')).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null;
  return { equipe: await equipe(t), semana: { faturamento: sem.atual.faturamento, pedidos: sem.atual.pedidos, ticket: sem.atual.ticket, conversao: sem.atual.conversao, variacoes: sem.variacoes },
    pendencias: abertas.filter((x) => x.status === 'aguardando_dono').length, resumo, ai: aiEnabled() };
});
on('GET', '/atividade', ({ t, q }) => listActivity(t, { limit: Math.min(200, Number(q.limit) || 60), agent: q.agente }));
on('GET', '/resultados', ({ t }) => resultados(t));

// tarefas
on('GET', '/tarefas', ({ t, q }) => listTasks(t, { status: q.status, responsavel: q.responsavel, tipo: q.tipo }));
on('POST', '/tarefas', ({ t, b }) => { if (!b?.titulo || !AGENT_KEYS.includes(b.responsavel)) throw new HttpError(400, 'Informe responsável e título'); return createTask(t, { responsavel: b.responsavel, titulo: b.titulo, prioridade: b.prioridade, solicitante: 'dono', tipo: 'pedido' }); });
on('PATCH', '/tarefas/:id', async ({ t, p, b }) => { own(await getTask(p.id), t); return updateTask(p.id, { status: b.status, resultado: b.resultado ?? undefined }, 'dono'); });
on('POST', '/tarefas/:id/aprovar', async ({ t, p }) => aprovarTarefa(t, own(await getTask(p.id), t)));
on('POST', '/tarefas/:id/recusar', async ({ t, p }) => { own(await getTask(p.id), t); return updateTask(p.id, { status: 'recusada', resultado: 'Recusada pelo dono' }, 'dono'); });

// agentes
on('GET', '/agentes/:a/config', ({ t, p }) => getConfig(t, agente(p.a)));
on('PUT', '/agentes/:a/config', async ({ t, p, b }) => { const c = await saveConfig(t, agente(p.a), b); log(t, p.a, `Configuração de ${AGENTS[p.a].nome} atualizada pelo dono`, { type: 'config' }); return c; });
on('POST', '/agentes/:a/contratar', async ({ t, p, b }) => { agente(p.a); const r = await setHired(t, p.a, b?.contratado !== false); log(t, p.a, `${AGENTS[p.a].nome} ${b?.contratado !== false ? 'contratado(a)' : 'removido(a) do plano'}`, { type: 'plano' }); return r; });
on('GET', '/agentes/:a/chat', async ({ t, p }) => (await alex.getChat(t, agente(p.a))).mensagens);
on('POST', '/agentes/:a/conversar', async ({ t, p, b }) => {
  const a = agente(p.a); if (!b?.texto) throw new HttpError(400, 'Escreva uma mensagem');
  if (a === 'alex') return alex.conversar(t, b.texto);
  if (a === 'sol') return sol.conversar(t, b.texto);
  if (a === 'flora') throw new HttpError(400, 'A Flora conversa com os clientes: use o simulador em Atendimento');
  if (!(await active(t, a))) return { texto: `${AGENTS[a].nome} não está contratado(a) ou está pausado(a).` };
  const chat = await alex.getChat(t, a); chat.mensagens.push({ role: 'user', texto: b.texto, em: now() });
  const task = await createTask(t, { responsavel: a, solicitante: 'dono', tipo: 'pedido', titulo: b.texto.slice(0, 140) });
  const texto = a === 'mari' ? 'Anotado! Coloquei na minha lista de tarefas e preparo a peça para a sua aprovação.' : 'Anotado! Vou considerar isso na próxima análise das campanhas e te trago uma proposta para aprovar.';
  if (a === 'mari') { mari.planejarSemana(t, { motivo: `pedido do dono: ${b.texto}` }).then(() => updateTask(task.id, { status: 'concluida', resultado: 'Peças criadas em Conteúdo.' })).catch(() => {}); }
  if (a === 'caio') { caio.analisar(t, { motivo: `pedido do dono: ${b.texto}` }).then(() => updateTask(task.id, { status: 'concluida', resultado: 'Propostas em Tarefas.' })).catch(() => {}); }
  chat.mensagens.push({ role: 'assistant', texto, em: now() }); await alex.saveChat(chat);
  return { texto };
});
on('POST', '/agentes/:a/executar', async ({ t, p }) => {
  const a = agente(p.a); if (!(await active(t, a))) throw new HttpError(409, `${AGENTS[a].nome} não está ativo(a)`);
  if (a === 'alex') return alex.rotina(t);
  if (a === 'mari') return { pecas: (await mari.planejarSemana(t, { motivo: 'acionado pelo dono' })).length };
  if (a === 'caio') return caio.analisar(t, { motivo: 'acionado pelo dono' });
  if (a === 'flora') return { automacoes: (await aut.executarAutomacoes(t)).length };
  return { ok: true };
});
on('POST', '/rotinas', async ({ t }) => ({ feitos: await rotinas(t, { forcar: true }) }));

// loja (Alex)
on('GET', '/loja/produtos', async ({ t }) => { const s = await getSettings(t); const im = await insumoMap(t); const out = []; for (const p of await listProducts(t)) out.push(await produtoView(t, p, s, im)); return out; });
on('GET', '/loja/insumos', ({ t }) => listInsumos(t));
on('GET', '/loja/configuracoes', ({ t }) => getSettings(t));
on('GET', '/loja/alteracoes', async ({ t }) => (await listChanges(t)).slice(0, 100).map(({ ops, ...c }) => ({ ...c, itens: ops.length })));
on('POST', '/loja/alteracoes/:id/desfazer', ({ t, p }) => undoChange(t, p.id, 'dono'));
on('POST', '/loja/acao', ({ t, b }) => executar(t, b.acao, b.params, { comando: 'painel', confirmado: true }));
on('GET', '/alex/resumo', ({ t }) => alex.resumoDiario(t));
on('GET', '/alex/semana', ({ t }) => alex.relatorioSemanal(t));
on('GET', '/alex/compras', ({ t }) => alex.sugestaoCompras(t));
on('GET', '/alex/recomendacoes', async ({ t }) => { await alex.registrarRecomendacoes(t); return listTasks(t, { tipo: 'recomendacao' }); });

// finanças (Sol)
on('GET', '/financas', async ({ t }) => { const P = await params(t); return { config: await getConfig(t, 'sol'), custos_fixos_total: P.fixos, variaveis_pct: P.varPct, margens: await margens(t), resumo: await resumoPeriodo(t), diagnostico: await diagnosticoMargem(t) }; });
on('PUT', '/financas', ({ t, b }) => saveConfig(t, 'sol', b));
on('POST', '/financas/preco', async ({ t, b }) => { const r = await precoSugerido(t, { custo: Number(b.custo), margemAlvoPct: b.margem_alvo_pct != null ? Number(b.margem_alvo_pct) : undefined }); return { ...r, texto: sol.textoPreco(r) }; });
on('POST', '/financas/desconto', async ({ t, b }) => { const d = await impactoDesconto(t, { produto: own(await getProduct(b.produto_id), t), descontoPct: Number(b.desconto_pct) }); return { ...d, texto: sol.textoDesconto(d) }; });
on('PUT', '/insumos/:id', async ({ t, p, b }) => { const i = own(await db().get('insumos', p.id), t); return db().put('insumos', { ...i, ...Object.fromEntries(['custo', 'estoque', 'perda_pct', 'compra_prevista'].filter((k) => b[k] !== undefined).map((k) => [k, b[k] === '' || b[k] == null ? null : Number(b[k])])) }); });
on('PUT', '/produtos/:id/custo', async ({ t, p, b }) => {
  const pr = own(await getProduct(p.id), t);
  await applyChanges(t, { actor: 'sol', descricao: `Custo de ${pr.nome} atualizado`, ops: [{ coll: 'products', id: pr.id, after: { ...pr, custo_informado: b.custo_informado === '' ? null : Number(b.custo_informado) } }] });
  return analisarProduto(t, await getProduct(p.id));
});

// atendimento (Flora)
on('GET', '/atendimento/conversas', async ({ t }) => {
  const out = [];
  for (const c of (await db().list('conversations', t)).sort((a, b) => ((a.updated_at || '') < (b.updated_at || '') ? 1 : -1))) out.push({ ...c, ultima: (await flora.listMessages(t, c.id)).slice(-1)[0] || null });
  return out;
});
on('GET', '/atendimento/conversas/:id', async ({ t, p }) => { const c = own(await db().get('conversations', decodeURIComponent(p.id)), t); return { conversa: c, mensagens: await flora.listMessages(t, c.id), pedidos: await listOrders(t, (o) => o.contato === c.contato) }; });
on('POST', '/atendimento/mensagem', ({ t, b }) => { if (!b?.texto) throw new HttpError(400, 'texto é obrigatório'); return flora.receberMensagem(t, { canal: b.canal || 'chat_loja', contato: b.contato || `visitante_${Date.now()}`, nome: b.nome, texto: b.texto }); });
on('POST', '/atendimento/conversas/:id/assumir', ({ t, p, b }) => flora.mensagemFuncionario(t, decodeURIComponent(p.id), b?.texto || 'Oi! Aqui é da equipe da loja, vou continuar seu atendimento.'));
on('POST', '/atendimento/conversas/:id/devolver', async ({ t, p }) => { await flora.devolverParaFlora(t, decodeURIComponent(p.id)); return { ok: true }; });
on('GET', '/pedidos', async ({ t }) => (await listOrders(t)).slice(0, 100));
on('POST', '/pedidos/:id/simular-pagamento', async ({ t, p }) => { if (!(await getTenant(t)).demo) throw new HttpError(403, 'Disponível só na demonstração; em lojas reais o pagamento é confirmado pelo sistema.'); return confirmarPagamento(t, p.id, 'simulação da demonstração'); });

// conteúdo (Mari)
on('GET', '/conteudo/posts', ({ t, q }) => mari.listPosts(t, q.status));
on('POST', '/conteudo/aprovar', ({ t, b }) => mari.aprovar(t, b.ids || []));
on('POST', '/conteudo/posts/:id/ajustar', async ({ t, p, b }) => { own(await mari.getPost(p.id), t); return mari.ajustar(t, p.id, b.pedido || ''); });
on('POST', '/conteudo/posts/:id/descartar', async ({ t, p }) => { own(await mari.getPost(p.id), t); await mari.descartar(t, p.id); return { ok: true }; });
on('POST', '/conteudo/posts/:id/publicar-agora', async ({ t, p }) => { const po = own(await mari.getPost(p.id), t); await db().put('posts', { ...po, status: 'agendado', scheduled_at: new Date().toISOString() }); await mari.publicarDevidos(t); return mari.getPost(p.id); });
on('GET', '/conteudo/fotos', ({ t }) => mari.listPhotos(t));
on('POST', '/conteudo/fotos', ({ t, b }) => mari.addPhoto(t, b));
on('DELETE', '/conteudo/fotos/:id', async ({ t, p }) => { await mari.removePhoto(t, p.id); return { ok: true }; });

// anúncios (Caio)
on('GET', '/anuncios', async ({ t }) => {
  const campanhas = [];
  for (const c of await caio.listCampaigns(t)) campanhas.push({ ...c, produtos: await Promise.all((c.produto_ids || []).map(async (id) => (await getProduct(id))?.nome)) });
  const reps = (await db().list('reports', t, (r) => r.agent === 'caio')).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { campanhas, config: await getConfig(t, 'caio'), verba_teste: await caio.verbaTeste(t), ultima_analise: reps[0] || null, mari_contratada: await active(t, 'mari') };
});
on('POST', '/anuncios/:id/pausar', async ({ t, p }) => { await caio.pausarManual(t, p.id); return { ok: true }; });

// eventos vindos da iFlores (webhooks). Idempotente: o mesmo event_id é processado uma única vez.
on('POST', '/eventos', async ({ t, b }) => {
  const { id: eventId, type, data = {} } = b || {};
  if (!type) throw new HttpError(400, 'type é obrigatório');
  if (eventId) {
    const k = `${t}:evt:${eventId}`;
    if (await db().get('eventos_recebidos', k)) return { ok: true, duplicado: true };
    await db().put('eventos_recebidos', { id: k, tenant_id: t, type });
  }
  const achar = async () => (data.order_id ? getOrder(data.order_id) : (await db().list('orders', t, (x) => x.external_id === data.external_id))[0]);
  switch (type) {
    case 'payment.confirmed': { const o = await achar(); return confirmarPagamento(t, own(o, t).id, 'sistema'); }
    case 'order.created': case 'order.updated': return crm.aplicarPedidoIflores(t, data);
    case 'order.status': { const o = await achar(); return mudarStatus(t, own(o, t).id, data.status); }
    case 'customer.created': case 'customer.updated': return crm.aplicarClienteIflores(t, data);
    case 'customer.optout': return crm.salvarContato(t, { contato: data.contato || data.telefone, optin_marketing: false }, { origem: 'iflores' });
    case 'review.created': publish(t, 'avaliacao.recebida', { nota: data.nota, comentario: data.comentario, cliente: data.cliente }); return { ok: true };
    default: log(t, 'alex', `Evento recebido da iFlores: ${type}`, { type: 'evento' }); return { ok: true, ignorado: true };
  }
});
on('POST', '/pedidos/:id/status', async ({ t, p, b }) => mudarStatus(t, own(await getOrder(p.id), t).id, b.status));

// CRM
on('GET', '/crm/contatos', async ({ t, q }) => (await crm.listarContatos(t, { busca: q.busca, etapa: q.etapa, tag: q.tag, optin: q.optin === undefined || q.optin === '' ? undefined : q.optin === 'true' })).slice(0, 300));
on('GET', '/crm/funil', async ({ t }) => ({ etapas: crm.ETAPAS, contagem: await crm.funil(t) }));
on('POST', '/crm/contatos', ({ t, b }) => { if (!b?.contato) throw new HttpError(400, 'Informe o telefone'); return crm.salvarContato(t, b, { origem: 'painel' }); });
on('GET', '/crm/contatos/:tel', async ({ t, p }) => { const r = await crm.linhaDoTempo(t, decodeURIComponent(p.tel)); if (!r) throw nf('Contato não encontrado'); return r; });
on('PATCH', '/crm/contatos/:tel', async ({ t, p, b }) => { const tel = decodeURIComponent(p.tel); if (!(await crm.getContato(t, tel))) throw nf('Contato não encontrado'); const { nome, email, tags, optin_marketing, datas, data_ocasiao, ocasiao } = b; return crm.salvarContato(t, { contato: tel, nome, email, tags, optin_marketing, datas, data_ocasiao, ocasiao }, { origem: 'painel' }); });
on('POST', '/crm/contatos/:tel/notas', ({ t, p, b }) => crm.adicionarNota(t, decodeURIComponent(p.tel), b.texto));
on('GET', '/crm/sincronizacao', async ({ t }) => ({ ...(await crm.estadoSync(t)), fila: (await listarOutbox(t)).filter((o) => o.status !== 'enviado').slice(0, 50) }));
on('POST', '/crm/sincronizar', async ({ t }) => { const r = await crm.sincronizar(t).catch((e) => ({ erro: e.message })); return { ...r, estado: await crm.estadoSync(t) }; });
on('POST', '/crm/reenviar-falhas', async ({ t }) => { await crm.reenviarFalhas(t); return crm.estadoSync(t); });

// automações
on('GET', '/automacoes', ({ t }) => aut.listarAutomacoes(t));
on('PUT', '/automacoes/:id', ({ t, p, b }) => aut.salvarAutomacao(t, p.id, b || {}));
on('GET', '/automacoes/execucoes', ({ t, q }) => aut.listarExecucoes(t, Math.min(300, Number(q.limit) || 100)));
on('POST', '/automacoes/executar', async ({ t }) => ({ execucoes: (await aut.executarAutomacoes(t)).length }));

// conexão: checklist para o lojista conectar sem ajuda técnica
on('GET', '/conexao', async ({ t }) => {
  const tn = await getTenant(t); const I = tn.integrations || {};
  const passos = [
    { id: 'iflores', nome: 'Sistema iFlores', para: 'Todos os agentes (catálogo, pedidos, clientes)', ok: !!tn.iflores?.connected, obrigatorio: true },
    { id: 'whatsapp', nome: 'WhatsApp Business', para: 'Flora e automações', ok: !!I.whatsapp?.connected, obrigatorio: await hired(t, 'flora') },
    { id: 'instagram', nome: 'Instagram', para: 'Mari', ok: !!I.instagram?.connected, obrigatorio: await hired(t, 'mari') },
    { id: 'meta_ads', nome: 'Meta Ads', para: 'Caio', ok: !!I.meta_ads?.connected, obrigatorio: await hired(t, 'caio') },
    { id: 'google_ads', nome: 'Google Ads', para: 'Caio', ok: !!I.google_ads?.connected, obrigatorio: false },
  ];
  const faltando = passos.filter((x) => x.obrigatorio && !x.ok);
  return { passos, pronto: !faltando.length, proximo: faltando[0]?.id || null, sincronizacao: await crm.estadoSync(t), demo: !!tn.demo, loja_id: t };
});

// webhook de saída (o sistema da loja recebe o que os agentes fizeram)
on('PUT', '/webhook', async ({ t, b }) => { const tn = await getTenant(t); await db().put('tenants', { ...tn, webhook: { ...tn.webhook, ...(b.url !== undefined ? { url: String(b.url) } : {}), ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}) } }); return publicTenant(await getTenant(t)).webhook; });

// integrações
on('PUT', '/integracoes/:nome', async ({ t, p, b }) => {
  const tn = await getTenant(t); const nome = p.nome;
  if (!['iflores', 'whatsapp', 'meta_ads', 'google_ads', 'instagram'].includes(nome)) throw nf('Integração inválida');
  const limpo = Object.fromEntries(Object.entries(b || {}).filter(([, v]) => !String(v).includes('••••')));
  const upd = nome === 'iflores' ? { ...tn, iflores: { ...tn.iflores, ...limpo, connected: !!(limpo.base_url && (limpo.token || tn.iflores?.token)) } } : { ...tn, integrations: { ...tn.integrations, [nome]: { ...tn.integrations[nome], ...limpo, connected: true } } };
  if (tn.demo) return { ok: false, mensagem: 'Na demonstração as integrações não conectam de verdade. Na loja instalada, este passo valida o acesso na hora.', tenant: publicTenant(tn) };
  await db().put('tenants', upd);
  log(t, 'alex', `Integração ${nome} configurada`, { type: 'integracao' });
  return { ok: true, tenant: publicTenant(upd) };
});

export async function handle({ method, path, query = {}, body = null, tenantId }) {
  for (const [m, re, fn] of routes) {
    const match = path.match(re);
    if (match && m === method) {
      try {
        const resultado = (await fn({ t: tenantId, p: match.groups || {}, q: query, b: body || {} })) ?? { ok: true };
        await esperarReacoes(tenantId); // a resposta já mostra o efeito nos outros agentes
        return { status: 200, body: resultado };
      }
      catch (e) {
        if (e.name === 'IsolationError') { console.warn(`[isolamento] ${tenantId} ${method} ${path}: ${e.message}`); return { status: 404, body: { error: 'Não encontrado' } }; }
        if (e.status) return { status: e.status, body: { error: e.message } };
        console.error(e); return { status: 500, body: { error: e.message || 'Erro interno' } };
      }
    }
  }
  return { status: 404, body: { error: 'Rota não encontrada' } };
}

export { periodo };
