// Webhooks de saída: avisa o sistema iFlores (ou outro sistema da loja) sobre eventos dos agentes.
// Assinatura: header X-IFlores-Signature = hex(HMAC-SHA256(secret, body)).
import crypto from 'node:crypto';
import { get } from '../db.js';

export async function dispatchWebhook(tenantId, event, payload) {
  const tenant = get('SELECT * FROM tenants WHERE id = ?', tenantId);
  const hook = tenant?.webhook;
  if (!hook?.url || !hook.enabled) return;
  if (hook.events?.length && !hook.events.includes(event) && !hook.events.includes('*')) return;
  const body = JSON.stringify({ event, tenant_id: tenantId, sent_at: new Date().toISOString(), data: payload });
  const signature = crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
  await fetch(hook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iflores-signature': signature, 'x-iflores-event': event },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

export function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
