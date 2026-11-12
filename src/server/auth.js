// Chaves de API das lojas e tokens do painel embutido (iframe na iFlores).
import crypto from 'node:crypto';
import { db } from '../core/store.js';

const SECRET = () => process.env.APP_SECRET || 'dev-secret-troque';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function novaChave(tenantId) {
  const key = `ifa_${crypto.randomBytes(24).toString('base64url')}`;
  db().put('apikeys', { id: sha(key), tenant_id: tenantId });
  const t = db().get('tenants', tenantId); db().put('tenants', { ...t, api_key_prefix: key.slice(0, 10) });
  for (const k of db().list('apikeys', tenantId)) if (k.id !== sha(key)) db().del('apikeys', k.id);
  return key;
}
export const tenantPorChave = (key) => (key?.startsWith('ifa_') ? db().get('apikeys', sha(key))?.tenant_id || null : null);

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
