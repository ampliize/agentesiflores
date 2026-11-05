import './env.js';
import path from 'node:path';
import express from 'express';
import { api } from './routes/api.js';
import { webhooks } from './routes/webhooks.js';
import { startScheduler } from './scheduler.js';
import { MEDIA_DIR } from './lib/art.js';
import { aiEnabled, MODEL } from './lib/llm.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));

  // CORS para o backend/front da iFlores consumir a API aberta
  app.use('/api', (req, res, next) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-platform-key, x-iflores-signature', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // o painel pode ser embutido em iframe dentro da iFlores
  app.use((req, res, next) => { res.set('content-security-policy', `frame-ancestors 'self' ${process.env.FRAME_ANCESTORS || 'https://*.iflores.app.br'}`); next(); });

  app.get('/health', (_req, res) => res.json({ ok: true, ai: aiEnabled(), model: aiEnabled() ? MODEL() : null }));
  app.use('/api/v1', api);
  app.use('/webhooks', webhooks);
  app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }));
  app.use('/docs', express.static(path.resolve('docs')));
  app.use(express.static(path.resolve('public')));
  app.get(['/painel', '/'], (_req, res) => res.sendFile(path.resolve('public/index.html')));

  app.use((err, _req, res, _next) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno' });
  });
  return app;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`🌷 iFlores Equipe Virtual rodando em http://localhost:${port}`);
    console.log(aiEnabled() ? `   IA: ${MODEL()}` : '   IA: MODO DEMONSTRAÇÃO (defina ANTHROPIC_API_KEY para usar Claude)');
  });
  if (process.env.SCHEDULER !== 'off') startScheduler();
}
