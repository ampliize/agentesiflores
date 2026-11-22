// Webhook de saída: avisa o sistema da loja sobre o que os agentes fizeram.
// Assinatura: X-IFlores-Signature = hex(HMAC-SHA256(segredo, corpo)).
import crypto from 'node:crypto';
import { bus } from '../core/events.js';
import { db } from '../core/store.js';

export function iniciarWebhooks() {
  bus.on('webhook', async ({ tenantId, event, payload }) => {
    const hook = (await db().get('tenants', tenantId))?.webhook;
    if (!hook?.enabled || !hook.url) return;
    const body = JSON.stringify({ event, tenant_id: tenantId, sent_at: new Date().toISOString(), data: payload });
    const sig = crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
    try { await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-iflores-signature': sig, 'x-iflores-event': event }, body, signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ }
  });
}
export function assinaturaValida(secret, raw, sig) {
  if (!secret || !sig) return false;
  const exp = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return exp.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(sig)));
}
