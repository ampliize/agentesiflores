// Webhook do WhatsApp Cloud API. Configure no app da Meta:
//   URL: {PUBLIC_URL}/webhooks/whatsapp/{tenantId}   Verify token: WHATSAPP_VERIFY_TOKEN
import { Router } from 'express';
import { getTenant } from '../lib/tenants.js';
import { parseIncoming } from '../integrations/whatsapp.js';
import { handleIncoming } from '../agents/atendente.js';

export const webhooks = Router();

webhooks.get('/whatsapp/:tenantId', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === (process.env.WHATSAPP_VERIFY_TOKEN || 'iflores-verify')) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

webhooks.post('/whatsapp/:tenantId', (req, res) => {
  const tenant = getTenant(req.params.tenantId);
  res.sendStatus(200); // a Meta exige resposta rápida; processamos em seguida
  if (!tenant) return;
  for (const m of parseIncoming(req.body)) {
    handleIncoming(tenant.id, { channel: 'whatsapp', contact: m.from, name: m.name, text: m.text }).catch((err) => console.error('atendente', err));
  }
});
