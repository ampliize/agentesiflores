// Servidor da Equipe dos Sonhos: API aberta, painel embutível, webhooks e agendador.
import './env.js';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { Resvg } from '@resvg/resvg-js';
import { init, rotinas } from '../core/index.js';
import { db, comLoja, createMemoryStore } from '../core/store.js';
import { handle } from '../core/api.js';
import { bus } from '../core/events.js';
import { seedDemo } from '../core/seed.js';
import { AGENT_KEYS, PLANO_PADRAO } from '../core/team.js';
import { receberMensagem } from '../core/agents/flora.js';
import { parseIncoming } from '../core/integrations/whatsapp.js';
import { aiEnabled, MODEL } from '../core/llm.js';
import { createSupabaseStore } from './supabase-store.js';
import { novaChave, tenantPorChave, assinarSessao, verificarSessao } from './auth.js';
import { iniciarWebhooks, assinaturaValida } from './webhooks-out.js';
import { ativarContexto, dentroDoLimite, porLoja } from './contexto.js';

/** Store do servidor: Supabase quando configurado; memória só para desenvolvimento (não persiste). */
function storePadrao() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) return createSupabaseStore();
  // na Vercel não existe disco: sem Supabase, a loja perderia tudo a cada requisição
  if (process.env.VERCEL) throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY nas variáveis da Vercel');
  console.warn('[aviso] SUPABASE_URL/SUPABASE_SERVICE_KEY não definidos: usando memória (os dados somem ao reiniciar).');
  return createMemoryStore();
}

export function createApp({ store } = {}) {
  ativarContexto();
  init(store || storePadrao());
  iniciarWebhooks();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '12mb', verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
  app.use('/api', (req, res, next) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-platform-key, x-iflores-signature', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use((_req, res, next) => { res.set('content-security-policy', `frame-ancestors 'self' ${process.env.FRAME_ANCESTORS || 'https://*.iflores.app.br'}`); next(); });
  const base = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const painel = (req, token) => `${base(req)}/painel?token=${encodeURIComponent(token)}`;
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/health', (_req, res) => res.json({ ok: true, ia: aiEnabled() ? MODEL() : 'demonstração' }));

  // ---------- rotinas automáticas, chamadas pelo n8n (ou pelo cron) a cada poucos minutos ----------
  app.post('/api/cron/rotinas', wrap(async (req, res) => {
    const esperado = process.env.CRON_SECRET;
    if (!esperado || req.get('authorization') !== `Bearer ${esperado}`) return res.status(401).json({ error: 'Não autorizado' });
    const ids = (await db().list('tenants', null, (x) => x.status === 'active')).map((t) => t.id);
    const erros = await porLoja(ids, (id) => comLoja(id, () => rotinas(id)));
    res.json({ lojas: ids.length, erros });
  }));

  // ---------- plataforma iFlores ----------
  const plataforma = (req, res, next) => (process.env.IFLORES_PLATFORM_KEY && req.get('x-platform-key') === process.env.IFLORES_PLATFORM_KEY ? next() : res.status(401).json({ error: 'X-Platform-Key inválida' }));
  app.post('/api/v1/plataforma/lojas', plataforma, wrap(async (req, res) => {
    const { nome, iflores_store_id, iflores = {}, agentes = PLANO_PADRAO } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    if (iflores_store_id && (await db().list('tenants', null, (t) => t.iflores_store_id === iflores_store_id)).length) return res.status(409).json({ error: 'Loja já cadastrada' });
    const id = `loja_${crypto.randomBytes(8).toString('hex')}`;
    await db().put('tenants', { id, tenant_id: id, name: nome, iflores_store_id: iflores_store_id || null, status: 'active', demo: false,
      plano: { agentes: Object.fromEntries(AGENT_KEYS.map((k) => [k, agentes.includes(k)])) },
      iflores: { base_url: iflores.base_url || '', token: iflores.token || '', connected: !!(iflores.base_url && iflores.token) },
      integrations: { whatsapp: { connected: false }, meta_ads: { connected: false }, google_ads: { connected: false }, instagram: { connected: false } },
      webhook: { url: '', enabled: false, secret: crypto.randomBytes(16).toString('hex') } });
    const api_key = await novaChave(id);
    const criada = await db().get('tenants', id);
    res.status(201).json({ loja_id: id, api_key, webhook_secret: criada.webhook.secret, panel_url: painel(req, assinarSessao(id)) });
  }));
  app.post('/api/v1/plataforma/lojas/:storeId/sessao', plataforma, wrap(async (req, res) => {
    const t = (await db().list('tenants', null, (x) => x.iflores_store_id === req.params.storeId || x.id === req.params.storeId))[0];
    if (!t) return res.status(404).json({ error: 'Loja não encontrada' });
    const token = assinarSessao(t.id, 8 * 3600, { u: req.body?.usuario || '' });
    res.json({ token, panel_url: painel(req, token), expira_em: 28800 });
  }));
  app.post('/api/v1/demo', wrap(async (req, res) => {
    if (process.env.ALLOW_DEMO === 'false') return res.status(403).json({ error: 'Demonstração desativada' });
    const t = await seedDemo();
    comLoja(t, () => rotinas(t, { forcar: true })).catch(() => {});
    res.json({ token: assinarSessao(t), panel_url: painel(req, assinarSessao(t)) });
  }));
  app.post('/api/v1/chave/nova', wrap(async (req, res) => { const t = await auth(req); if (!t) return res.status(401).json({ error: 'Não autorizado' }); res.json({ api_key: await novaChave(t) }); }));

  // ---------- autenticação da loja ----------
  async function auth(req) {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token;
    const t = (await tenantPorChave(tok)) || verificarSessao(tok)?.t || null;
    if (!t) return null;
    const tn = await db().get('tenants', t);
    return tn?.status === 'active' ? t : null;
  }
  app.get('/api/v1/tempo-real', wrap(async (req, res) => {
    const t = await auth(req); if (!t) return res.status(401).end();
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders();
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const off = bus.on(`t:${t}`, send);
    req.on('close', () => { clearInterval(ping); off(); });
  }));
  app.post('/api/v1/eventos', wrap(async (req, res, next) => {
    const t = await auth(req); if (!t) return res.status(401).json({ error: 'Não autorizado' });
    const sig = req.get('x-iflores-signature');
    const tn = await db().get('tenants', t);
    if (sig && !assinaturaValida(tn.webhook?.secret, req.rawBody || '', sig)) return res.status(401).json({ error: 'Assinatura inválida' });
    next();
  }));
  app.all('/api/v1/*rota', wrap(async (req, res) => {
    const t = await auth(req); if (!t) return res.status(401).json({ error: 'Não autorizado' });
    if (!dentroDoLimite(t)) return res.status(429).json({ error: 'Muitas requisições desta loja. Tente em instantes.' });
    const r = await comLoja(t, () => handle({ method: req.method, path: `/${req.params.rota.join('/')}`, query: req.query, body: req.body, tenantId: t }));
    res.status(r.status).json(r.body);
  }));

  // ---------- imagens das peças em PNG (o Instagram não aceita SVG) ----------
  app.get('/media/posts/:id/:n.png', wrap(async (req, res) => {
    const raw = await db().get('posts', req.params.id); const s = raw?.slides?.[Number(req.params.n) - 1];
    if (!s?.imagem) return res.sendStatus(404);
    const svg = decodeURIComponent(s.imagem.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    res.type('png').set('cache-control', 'public, max-age=3600').send(new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
  }));

  // ---------- WhatsApp Cloud API ----------
  app.get('/webhooks/whatsapp/:loja', (req, res) => (req.query['hub.verify_token'] === (process.env.WHATSAPP_VERIFY_TOKEN || 'iflores-verify') ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
  app.post('/webhooks/whatsapp/:loja', wrap(async (req, res) => {
    res.sendStatus(200);
    const t = await db().get('tenants', req.params.loja); if (!t) return;
    for (const m of parseIncoming(req.body)) comLoja(t.id, () => receberMensagem(t.id, { canal: 'whatsapp', contato: m.from, nome: m.name, texto: m.text })).catch((e) => console.error('flora', e));
  }));

  app.use('/docs', express.static(path.resolve('docs')));
  app.use(express.static(path.resolve('public')));
  // vitrine da equipe (o que o lojista vê primeiro) e o painel completo, que abre por Tarefas e Configurações
  app.get(['/', '/painel'], (_req, res) => res.sendFile(path.resolve('public/equipe/index.html')));
  app.get('/painel/crm', (_req, res) => res.sendFile(path.resolve('public/index.html')));
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message || 'Erro interno' }); });
  return app;
}

export function iniciarAgendador(ms = Number(process.env.SCHEDULER_INTERVAL || 60) * 1000) {
  const tick = async () => {
    const ids = (await db().list('tenants', null, (x) => x.status === 'active')).map((t) => t.id);
    const erros = await porLoja(ids, (id) => comLoja(id, () => rotinas(id)));
    for (const e of erros) console.error(`[rotinas] loja ${e.id}: ${e.erro}`);
  };
  return setInterval(tick, ms);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`🌷 Equipe dos Sonhos iFlores em http://localhost:${port} · IA: ${aiEnabled() ? MODEL() : 'modo demonstração'}`));
  if (process.env.SCHEDULER !== 'off') iniciarAgendador();
}
