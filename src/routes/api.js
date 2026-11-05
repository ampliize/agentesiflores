// API aberta v1 — usada pelo painel embutido, pelo backend da iFlores e por integrações de terceiros.
// Autenticação:
//   • Plataforma iFlores:  header `X-Platform-Key: <IFLORES_PLATFORM_KEY>`  (rotas /platform/*)
//   • Loja (tenant):       `Authorization: Bearer ifa_...` (chave de API)  ou  token de sessão do painel
import { Router } from 'express';
import { get, all, run } from '../db.js';
import * as T from '../lib/tenants.js';
import { AGENTS, AGENT_KEYS } from '../agents/defaults.js';
import { bus, listActivity, logActivity, getAgentStatus } from '../lib/events.js';
import { createTask, listTasks, updateTask, getTask } from '../lib/tasks.js';
import { runAgent } from '../agents/index.js';
import { handleIncoming, listMessages, conversationStats } from '../agents/atendente.js';
import { listPosts, getPost, updatePost, revisePost } from '../agents/social.js';
import { executeDecision } from '../agents/trafego.js';
import { computeKpis, agentScores, latestReport } from '../agents/gerente.js';
import { IFloresClient } from '../integrations/iflores.js';
import { MetaAds } from '../integrations/meta.js';
import { testWhatsApp } from '../integrations/whatsapp.js';
import { aiEnabled, MODEL } from '../lib/llm.js';
import { verifySignature } from '../lib/webhooks-out.js';

export const api = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });
const panelUrl = (req, token) => `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/painel?token=${encodeURIComponent(token)}`;

// ------------------------------------------------------------------ plataforma
function platformAuth(req, _res, next) {
  const key = req.get('x-platform-key');
  if (!process.env.IFLORES_PLATFORM_KEY || key !== process.env.IFLORES_PLATFORM_KEY) return next(httpError(401, 'X-Platform-Key inválida'));
  next();
}

/** A iFlores cria a loja quando o cliente contrata a Equipe Virtual. */
api.post('/platform/tenants', platformAuth, wrap(async (req, res) => {
  const { name, iflores_store_id, iflores } = req.body || {};
  if (!name) throw httpError(400, 'name é obrigatório');
  if (iflores_store_id && T.getTenantByStore(iflores_store_id)) throw httpError(409, 'Loja já cadastrada');
  const { tenant, api_key } = T.createTenant({ name, iflores_store_id, iflores });
  const token = T.signPanelToken(tenant.id);
  res.status(201).json({ tenant: T.publicTenant(tenant), api_key, panel_url: panelUrl(req, token) });
}));

/** A iFlores gera uma sessão curta para abrir o painel (iframe) do dono logado. */
api.post('/platform/tenants/:storeId/session', platformAuth, wrap(async (req, res) => {
  const t = T.getTenantByStore(req.params.storeId) || T.getTenant(req.params.storeId);
  if (!t) throw httpError(404, 'Loja não encontrada');
  const token = T.signPanelToken(t.id, 60 * 60 * 8, { u: req.body?.user_name || '' });
  res.json({ token, panel_url: panelUrl(req, token), expires_in: 28800 });
}));

/** Demonstração local: cria uma loja de exemplo e abre o painel (desative em produção). */
api.post('/demo', wrap(async (req, res) => {
  if (process.env.ALLOW_DEMO === 'false') throw httpError(403, 'Demo desativada');
  let t = T.getTenantByStore('demo');
  let api_key;
  if (!t) ({ tenant: t, api_key } = T.createTenant({ name: req.body?.name || 'Floricultura Jardim Encantado', iflores_store_id: 'demo' }));
  const token = T.signPanelToken(t.id);
  res.json({ token, panel_url: panelUrl(req, token), api_key });
}));

// ------------------------------------------------------------------ autenticação da loja
function tenantAuth(req, _res, next) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = bearer || req.query.token;
  let tenant = null;
  if (token?.startsWith('ifa_')) tenant = T.findTenantByApiKey(token);
  else { const p = T.verifyPanelToken(token); if (p) tenant = T.getTenant(p.t); }
  if (!tenant || tenant.status !== 'active') return next(httpError(401, 'Não autorizado'));
  req.tenant = tenant;
  next();
}
api.use(tenantAuth);
const agentParam = (req) => { if (!AGENT_KEYS.includes(req.params.agent)) throw httpError(404, 'Agente inválido'); return req.params.agent; };

// ------------------------------------------------------------------ loja
api.get('/me', (req, res) => res.json({ tenant: T.publicTenant(req.tenant), ai: { enabled: aiEnabled(), model: aiEnabled() ? MODEL() : null } }));
api.patch('/me', (req, res) => {
  const { name, brand } = req.body || {};
  res.json(T.publicTenant(T.updateTenantData(req.tenant.id, { ...(name ? { name } : {}), ...(brand ? { brand } : {}) })));
});
api.post('/api-key/rotate', (req, res) => res.json({ api_key: T.rotateApiKey(req.tenant.id) }));

// ------------------------------------------------------------------ equipe (visão de monitoramento)
api.get('/team', wrap(async (req, res) => {
  const id = req.tenant.id;
  const kpis = await computeKpis(id);
  const scores = agentScores(kpis);
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const counts = Object.fromEntries(all('SELECT agent, COUNT(*) AS n FROM activity WHERE tenant_id = ? AND created_at >= ? GROUP BY agent', id, dayAgo).map((r) => [r.agent, r.n]));
  const tasks = listTasks(id).filter((t) => ['todo', 'doing', 'review'].includes(t.status));
  const team = AGENT_KEYS.map((key) => {
    const cfg = T.getAgentConfig(id, key);
    const st = getAgentStatus(id, key);
    const last = listActivity(id, { agent: key, limit: 1 })[0];
    return {
      key, ...AGENTS[key], nome_exibicao: cfg.nome_exibicao, enabled: cfg.enabled,
      status: !cfg.enabled ? 'pausado' : st.status === 'trabalhando' ? 'trabalhando' : 'online',
      atual: st.current || (last ? last.message : 'Aguardando próxima tarefa'),
      ultima_atividade: last?.created_at || null,
      nota: scores[key], acoes_24h: counts[key] || 0,
      tarefas_abertas: tasks.filter((t) => t.agent === key).length,
    };
  });
  const posts = listPosts(id);
  res.json({
    team, kpis, atendimento: conversationStats(id, dayAgo),
    conteudo: { aguardando_aprovacao: posts.filter((p) => p.status === 'aguardando_aprovacao').length, agendados: posts.filter((p) => p.status === 'agendado').length, publicados: posts.filter((p) => p.status === 'publicado').length, em_revisao: posts.filter((p) => p.status === 'revisao_gerente').length },
    tarefas: { abertas: tasks.length, em_aprovacao: tasks.filter((t) => t.status === 'review').length },
    relatorio: latestReport(id),
    ai: { enabled: aiEnabled() },
  });
}));

// ------------------------------------------------------------------ configuração dos agentes
api.get('/agents', (req, res) => res.json(AGENT_KEYS.map((k) => ({ key: k, ...AGENTS[k], config: T.getAgentConfig(req.tenant.id, k) }))));
api.get('/agents/:agent/config', (req, res) => res.json(T.getAgentConfig(req.tenant.id, agentParam(req))));
api.put('/agents/:agent/config', (req, res) => {
  const agent = agentParam(req);
  const cfg = T.saveAgentConfig(req.tenant.id, agent, req.body || {});
  logActivity(req.tenant.id, agent, 'config', `Configuração de ${AGENTS[agent].nome} atualizada pelo dono`);
  res.json(cfg);
});
api.post('/agents/:agent/run', wrap(async (req, res) => {
  const agent = agentParam(req);
  if (!T.getAgentConfig(req.tenant.id, agent).enabled) throw httpError(409, 'Agente desativado');
  const result = await runAgent(req.tenant.id, agent, { ...(req.body || {}), reason: 'acionado pelo dono' });
  res.json({ ok: true, result });
}));

// ------------------------------------------------------------------ tarefas
api.get('/tasks', (req, res) => res.json(listTasks(req.tenant.id, { status: req.query.status, agent: req.query.agent })));
api.post('/tasks', (req, res) => {
  const { agent, title, priority, due_at } = req.body || {};
  if (!AGENT_KEYS.includes(agent) || !title) throw httpError(400, 'agent e title são obrigatórios');
  res.status(201).json(createTask(req.tenant.id, { agent, title, priority, due_at, created_by: 'dono' }));
});
api.patch('/tasks/:id', (req, res) => {
  const t = getTask(req.params.id); if (!t || t.tenant_id !== req.tenant.id) throw httpError(404, 'Tarefa não encontrada');
  const { status, title, priority, agent } = req.body || {};
  res.json(updateTask(t.id, Object.fromEntries(Object.entries({ status, title, priority, agent }).filter(([, v]) => v !== undefined))));
});
/** Aprovar sugestão do Tráfego (pausar/escalar/criar campanha). */
api.post('/tasks/:id/approve', wrap(async (req, res) => {
  const t = getTask(req.params.id); if (!t || t.tenant_id !== req.tenant.id) throw httpError(404, 'Tarefa não encontrada');
  const ads = new MetaAds(req.tenant);
  if (t.decision) await executeDecision(req.tenant, ads, { ...t.decision, motivo: 'aprovado pelo dono' });
  if (t.proposta) {
    await ads.createCampaign({ nome: t.proposta.nome, objetivo: t.proposta.objetivo, orcamento_diario: t.proposta.orcamento_diario, ativa: false });
    logActivity(req.tenant.id, 'trafego', 'campanha_criada', `Campanha "${t.proposta.nome}" criada após aprovação do dono`, t.proposta, 'success');
    createTask(req.tenant.id, { agent: 'social', title: `Criativos para campanha "${t.proposta.nome}": ${t.proposta.mensagem}`, created_by: 'trafego' });
  }
  res.json(updateTask(t.id, { status: 'done' }));
}));

// ------------------------------------------------------------------ monitoramento
api.get('/activity', (req, res) => res.json(listActivity(req.tenant.id, { limit: Math.min(200, Number(req.query.limit) || 50), agent: req.query.agent })));
api.get('/stream', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on(`tenant:${req.tenant.id}`, send);
  req.on('close', () => { clearInterval(ping); bus.off(`tenant:${req.tenant.id}`, send); });
});
api.get('/kpis', wrap(async (req, res) => res.json(await computeKpis(req.tenant.id))));
api.get('/reports', (req, res) => res.json(all('SELECT * FROM reports WHERE tenant_id = ? AND (? IS NULL OR agent = ?) ORDER BY created_at DESC LIMIT 30', req.tenant.id, req.query.agent || null, req.query.agent || null)));

// ------------------------------------------------------------------ atendimento
api.get('/conversations', (req, res) => res.json(all('SELECT * FROM conversations WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 100', req.tenant.id).map((c) => ({ ...c, ultima: listMessages(c.id).slice(-1)[0] || null }))));
api.get('/conversations/:id/messages', (req, res) => {
  const c = get('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?', req.params.id, req.tenant.id);
  if (!c) throw httpError(404, 'Conversa não encontrada');
  res.json({ conversation: c, messages: listMessages(c.id) });
});
api.post('/conversations/:id/mode', (req, res) => {
  const c = get('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?', req.params.id, req.tenant.id);
  if (!c) throw httpError(404, 'Conversa não encontrada');
  const mode = req.body?.mode === 'humano' ? 'humano' : 'bot';
  run('UPDATE conversations SET status = ? WHERE id = ?', mode, c.id);
  logActivity(req.tenant.id, 'atendente', 'modo', `Conversa com ${c.contact_name || c.contact} agora com ${mode === 'humano' ? 'atendente humano' : 'a IA'}`);
  res.json({ ok: true, mode });
});
/** Simulador (painel) e canal genérico para outros sistemas enviarem mensagens à Atendente. */
api.post('/chat', wrap(async (req, res) => {
  const { contact = 'simulador', name = 'Cliente teste', text, channel = 'simulador' } = req.body || {};
  if (!text) throw httpError(400, 'text é obrigatório');
  res.json(await handleIncoming(req.tenant.id, { channel: channel === 'whatsapp' ? 'api' : channel, contact, name, text }));
}));

// ------------------------------------------------------------------ conteúdo
api.get('/posts', (req, res) => res.json(listPosts(req.tenant.id, req.query.status)));
const ownPost = (req) => { const p = getPost(req.params.id); if (!p || p.tenant_id !== req.tenant.id) throw httpError(404, 'Peça não encontrada'); return p; };
api.post('/posts/:id/approve', (req, res) => {
  const p = ownPost(req);
  const scheduled_at = req.body?.scheduled_at || p.scheduled_at || new Date(Date.now() + 10 * 60e3).toISOString();
  const updated = updatePost(p.id, { aprovado_pelo_dono: true, scheduled_at }, p.formato === 'anuncio' ? 'aprovado' : 'agendado');
  logActivity(req.tenant.id, 'social', 'post_aprovado_dono', `Dono aprovou "${p.titulo_arte}"`, { post_id: p.id }, 'success');
  res.json(updated);
});
api.post('/posts/:id/reject', wrap(async (req, res) => {
  const p = ownPost(req);
  if (req.body?.feedback) return res.json(await revisePost(req.tenant.id, p.id, req.body.feedback, 'dono'));
  res.json(updatePost(p.id, {}, 'descartado'));
}));
api.post('/posts/:id/publish-now', (req, res) => {
  const p = ownPost(req);
  res.json(updatePost(p.id, { scheduled_at: new Date().toISOString() }, 'agendado'));
});

// ------------------------------------------------------------------ tráfego
api.get('/campaigns', wrap(async (req, res) => {
  const ads = new MetaAds(req.tenant);
  const list = ads.demo ? await ads.campaignsWithInsights() : all('SELECT * FROM campaigns WHERE tenant_id = ?', req.tenant.id);
  res.json({ demo: ads.demo, campaigns: list, ultima_analise: latestReport(req.tenant.id, 'trafego') });
}));
api.post('/campaigns/:externalId/:action', wrap(async (req, res) => {
  if (!['pause', 'scale'].includes(req.params.action)) throw httpError(404, 'Ação inválida');
  const c = get('SELECT * FROM campaigns WHERE tenant_id = ? AND external_id = ?', req.tenant.id, req.params.externalId);
  if (!c) throw httpError(404, 'Campanha não encontrada');
  const acao = req.params.action === 'pause' ? 'pausar' : 'escalar';
  await executeDecision(req.tenant, null, { acao, campanha: c, novo_orcamento: Math.round((c.orcamento_diario || 0) * 1.2), motivo: 'ação manual do dono' });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ integrações (assistente de conexão)
const INTEGRATIONS = ['iflores', 'whatsapp', 'meta_ads', 'instagram'];
api.put('/integrations/:name', wrap(async (req, res) => {
  const name = req.params.name; if (!INTEGRATIONS.includes(name)) throw httpError(404, 'Integração inválida');
  const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k, v]) => !(String(v).includes('••••') && /token/.test(k))));
  const patch = name === 'iflores' ? { iflores: { ...body, connected: !!(body.base_url && (body.token || req.tenant.iflores?.token)) } } : { integrations: { [name]: { ...body, connected: true } } };
  const tenant = T.updateTenantData(req.tenant.id, patch);
  const test = await testIntegration(tenant, name).catch((err) => ({ ok: false, error: err.message }));
  if (!test.ok) T.updateTenantData(req.tenant.id, name === 'iflores' ? { iflores: { connected: false } } : { integrations: { [name]: { connected: false } } });
  logActivity(req.tenant.id, 'gerente', 'integracao', `Integração ${name} ${test.ok ? 'conectada' : 'falhou: ' + test.error}`, {}, test.ok ? 'success' : 'error');
  res.json({ test, tenant: T.publicTenant(T.getTenant(req.tenant.id)) });
}));
api.delete('/integrations/:name', (req, res) => {
  const name = req.params.name; if (!INTEGRATIONS.includes(name)) throw httpError(404, 'Integração inválida');
  T.updateTenantData(req.tenant.id, name === 'iflores' ? { iflores: { connected: false, token: '' } } : { integrations: { [name]: { connected: false, access_token: '' } } });
  res.json(T.publicTenant(T.getTenant(req.tenant.id)));
});

async function testIntegration(tenant, name) {
  if (name === 'iflores') { const r = await new IFloresClient(tenant).ping(); return { ok: true, demo: !!r.demo, info: r }; }
  if (name === 'whatsapp') { const r = await testWhatsApp(tenant.integrations.whatsapp); T.updateTenantData(tenant.id, { integrations: { whatsapp: { display_phone: r.display_phone_number } } }); return { ok: true, info: r }; }
  if (name === 'meta_ads') { const list = await new MetaAds(tenant).campaignsWithInsights(); return { ok: true, info: { campanhas: list.length } }; }
  if (name === 'instagram') {
    const ig = tenant.integrations.instagram;
    const r = await fetch(`https://graph.facebook.com/v21.0/${ig.ig_user_id}?fields=username&access_token=${ig.access_token}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Instagram ${r.status}`);
    const j = await r.json(); T.updateTenantData(tenant.id, { integrations: { instagram: { username: j.username } } });
    return { ok: true, info: j };
  }
}

api.put('/webhook', (req, res) => {
  const { url, enabled, events } = req.body || {};
  res.json(T.publicTenant(T.updateTenantData(req.tenant.id, { webhook: { ...(url !== undefined ? { url } : {}), ...(enabled !== undefined ? { enabled: !!enabled } : {}), ...(events ? { events } : {}) } })));
});

// ------------------------------------------------------------------ eventos vindos da iFlores
/**
 * A iFlores envia eventos da loja (pedido criado/pago/entregue, produto sem estoque, avaliação…).
 * Assinatura opcional: header X-IFlores-Signature = HMAC-SHA256(webhook.secret, corpo).
 */
api.post('/events', wrap(async (req, res) => {
  const sig = req.get('x-iflores-signature');
  if (sig && !verifySignature(req.tenant.webhook?.secret, req.rawBody || '', sig)) throw httpError(401, 'Assinatura inválida');
  const { type, data = {} } = req.body || {};
  if (!type) throw httpError(400, 'type é obrigatório');
  const id = req.tenant.id;
  switch (type) {
    case 'order.created': logActivity(id, 'gerente', 'venda', `Novo pedido ${data.id || ''} na iFlores${data.total ? ` (R$ ${data.total})` : ''}`, data, 'success'); break;
    case 'order.delivered':
      logActivity(id, 'atendente', 'pos_venda', `Pedido ${data.id || ''} entregue — pós-venda agendado`, data);
      break;
    case 'product.out_of_stock':
      logActivity(id, 'trafego', 'estoque', `Produto ${data.nome || data.id} sem estoque — revisar anúncios`, data, 'warning');
      createTask(id, { agent: 'trafego', title: `Pausar anúncios do produto sem estoque: ${data.nome || data.id}`, created_by: 'gerente', priority: 'alta' });
      break;
    case 'review.created':
      if (Number(data.nota) >= 4) createTask(id, { agent: 'social', title: `Post de depoimento: "${String(data.comentario || '').slice(0, 80)}"`, created_by: 'gerente' });
      break;
    default: logActivity(id, 'gerente', 'evento', `Evento recebido da iFlores: ${type}`, data);
  }
  res.status(202).json({ ok: true });
}));
