// Chaves de API das lojas e tokens do painel embutido (iframe na iFlores).
import crypto from 'node:crypto';
import { db } from '../core/store.js';

const SECRET = () => process.env.APP_SECRET || 'dev-secret-troque';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function novaChave(tenantId) {
  const key = `ifa_${crypto.randomBytes(24).toString('base64url')}`;
  await db().put('apikeys', { id: sha(key), tenant_id: tenantId });
  const t = await db().get('tenants', tenantId);
  await db().put('tenants', { ...t, api_key_prefix: key.slice(0, 10) });
  for (const k of await db().list('apikeys', tenantId)) if (k.id !== sha(key)) await db().del('apikeys', k.id);
  return key;
}
export async function tenantPorChave(key) {
  if (!key?.startsWith('ifa_')) return null;
  return (await db().get('apikeys', sha(key)))?.tenant_id || null;
}

export function assinarSessao(tenantId, ttl = 8 * 3600, extra = {}) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, exp: Math.floor(Date.now() / 1000) + ttl, ...extra })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url')}`;
}
export function verificarSessao(token) {
  if (!token?.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const exp = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return d.exp > Date.now() / 1000 ? d : null;
}
