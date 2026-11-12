// Servidor da Equipe dos Sonhos: API aberta, painel embutível, webhooks e agendador.
import './env.js';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { Resvg } from '@resvg/resvg-js';
import { init, rotinas } from '../core/index.js';
import { db, comLoja } from '../core/store.js';
import { handle } from '../core/api.js';
import { bus } from '../core/events.js';
import { seedDemo } from '../core/seed.js';
import { AGENT_KEYS } from '../core/team.js';
import { renderSlideSvg } from '../core/art.js';
import { receberMensagem } from '../core/agents/flora.js';
import { parseIncoming } from '../core/integrations/whatsapp.js';
import { aiEnabled, MODEL } from '../core/llm.js';
import { createSqliteStore } from './sqlite-store.js';
import { novaChave, tenantPorChave, assinarSessao, verificarSessao } from './auth.js';
import { iniciarWebhooks, assinaturaValida } from './webhooks-out.js';
import { ativarContexto, dentroDoLimite, porLoja } from './contexto.js';

export function createApp({ store } = {}) {
  ativarContexto();
  init(store || createSqliteStore());
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

  app.get('/health', (_req, res) => res.json({ ok: true, ia: aiEnabled() ? MODEL() : 'demonstração' }));

  // ---------- plataforma iFlores ----------
  const plataforma = (req, res, next) => (process.env.IFLORES_PLATFORM_KEY && req.get('x-platform-key') === process.env.IFLORES_PLATFORM_KEY ? next() : res.status(401).json({ error: 'X-Platform-Key inválida' }));
  app.post('/api/v1/plataforma/lojas', plataforma, (req, res) => {
    const { nome, iflores_store_id, iflores = {}, agentes = AGENT_KEYS } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    if (iflores_store_id && db().list('tenants', null, (t) => t.iflores_store_id === iflores_store_id).length) return res.status(409).json({ error: 'Loja já cadastrada' });
    const id = `loja_${crypto.randomBytes(8).toString('hex')}`;
    db().put('tenants', { id, tenant_id: id, name: nome, iflores_store_id: iflores_store_id || null, status: 'active', demo: false,
      plano: { agentes: Object.fromEntries(AGENT_KEYS.map((k) => [k, agentes.includes(k)])) },
      iflores: { base_url: iflores.base_url || '', token: iflores.token || '', connected: !!(iflores.base_url && iflores.token) },
      integrations: { whatsapp: { connected: false }, meta_ads: { connected: false }, google_ads: { connected: false }, instagram: { connected: false } },
      webhook: { url: '', enabled: false, secret: crypto.randomBytes(16).toString('hex') } });
    const api_key = novaChave(id);
    res.status(201).json({ loja_id: id, api_key, panel_url: painel(req, assinarSessao(id)) });
  });
  app.post('/api/v1/plataforma/lojas/:storeId/sessao', plataforma, (req, res) => {
    const t = db().list('tenants', null, (x) => x.iflores_store_id === req.params.storeId || x.id === req.params.storeId)[0];
    if (!t) return res.status(404).json({ error: 'Loja não encontrada' });
    const token = assinarSessao(t.id, 8 * 3600, { u: req.body?.usuario || '' });
    res.json({ token, panel_url: painel(req, token), expira_em: 28800 });
  });
  app.post('/api/v1/demo', (req, res) => {
    if (process.env.ALLOW_DEMO === 'false') return res.status(403).json({ error: 'Demonstração desativada' });
    const t = seedDemo();
    comLoja(t, () => rotinas(t, { forcar: true })).catch(() => {});
    res.json({ token: assinarSessao(t), panel_url: painel(req, assinarSessao(t)) });
  });
  app.post('/api/v1/chave/nova', (req, res) => { const t = auth(req); if (!t) return res.status(401).json({ error: 'Não autorizado' }); res.json({ api_key: novaChave(t) }); });

  // ---------- autenticação da loja ----------
  function auth(req) {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token;
    const t = tenantPorChave(tok) || verificarSessao(tok)?.t || null;
    return t && db().get('tenants', t)?.status === 'active' ? t : null;
  }
  app.get('/api/v1/tempo-real', (req, res) => {
    const t = auth(req); if (!t) return res.status(401).end();
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders();
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const off = bus.on(`t:${t}`, send);
    req.on('close', () => { clearInterval(ping); off(); });
  });
  app.post('/api/v1/eventos', (req, res, next) => {
    const t = auth(req); if (!t) return res.status(401).json({ error: 'Não autorizado' });
    const sig = req.get('x-iflores-signature');
    if (sig && !assinaturaValida(db().get('tenants', t).webhook?.secret, req.rawBody || '', sig)) return res.status(401).json({ error: 'Assinatura inválida' });
    next();
  });
  app.all('/api/v1/*rota', async (req, res) => {
    const t = auth(req); if (!t) return res.status(401).json({ error: 'Não autorizado' });
    if (!dentroDoLimite(t)) return res.status(429).json({ error: 'Muitas requisições desta loja. Tente em instantes.' });
    const r = await comLoja(t, () => handle({ method: req.method, path: `/${req.params.rota.join('/')}`, query: req.query, body: req.body, tenantId: t }));
    res.status(r.status).json(r.body);
  });

  // ---------- imagens das peças em PNG (o Instagram não aceita SVG) ----------
  app.get('/media/posts/:id/:n.png', (req, res) => {
    const raw = db().get('posts', req.params.id); const s = raw?.slides?.[Number(req.params.n) - 1];
    if (!s?.imagem) return res.sendStatus(404);
    const svg = decodeURIComponent(s.imagem.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    res.type('png').set('cache-control', 'public, max-age=3600').send(new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
  });

  // ---------- WhatsApp Cloud API ----------
  app.get('/webhooks/whatsapp/:loja', (req, res) => (req.query['hub.verify_token'] === (process.env.WHATSAPP_VERIFY_TOKEN || 'iflores-verify') ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
  app.post('/webhooks/whatsapp/:loja', (req, res) => {
    res.sendStatus(200);
    const t = db().get('tenants', req.params.loja); if (!t) return;
    for (const m of parseIncoming(req.body)) comLoja(t.id, () => receberMensagem(t.id, { canal: 'whatsapp', contato: m.from, nome: m.name, texto: m.text })).catch((e) => console.error('flora', e));
  });

  app.use('/docs', express.static(path.resolve('docs')));
  app.use(express.static(path.resolve('public')));
  app.get(['/', '/painel'], (_req, res) => res.sendFile(path.resolve('public/index.html')));
  return app;
}

export function iniciarAgendador(ms = Number(process.env.SCHEDULER_INTERVAL || 60) * 1000) {
  const tick = async () => {
    const ids = db().list('tenants', null, (x) => x.status === 'active').map((t) => t.id);
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
