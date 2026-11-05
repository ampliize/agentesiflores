// Lojas (tenants), chaves de API, tokens do painel embutido e configs dos agentes.
import crypto from 'node:crypto';
import { get, all, run, uid, now } from '../db.js';
import { AGENT_KEYS, DEFAULT_CONFIG, mergeDeep } from '../agents/defaults.js';

const SECRET = () => process.env.APP_SECRET || 'dev-secret-change-me';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createTenant({ name, iflores_store_id, iflores = {}, plan = 'completo' }) {
  const id = uid('loja_');
  const apiKey = 'ifa_' + crypto.randomBytes(24).toString('base64url');
  const data = {
    plan,
    iflores: { base_url: iflores.base_url || '', token: iflores.token || '', connected: !!iflores.token },
    integrations: {
      whatsapp: { connected: false, phone_number_id: '', access_token: '', display_phone: '' },
      meta_ads: { connected: false, ad_account_id: '', access_token: '' },
      instagram: { connected: false, ig_user_id: '', access_token: '', username: '' },
    },
    webhook: { url: '', secret: crypto.randomBytes(16).toString('hex'), enabled: false, events: ['*'] },
    brand: { primary: '#c2185b', logo_url: '' },
  };
  run(
    'INSERT INTO tenants (id, name, iflores_store_id, api_key_hash, api_key_prefix, data, created_at) VALUES (?,?,?,?,?,?,?)',
    id, name, iflores_store_id || null, sha256(apiKey), apiKey.slice(0, 10), JSON.stringify(data), now(),
  );
  for (const agent of AGENT_KEYS) saveAgentConfig(id, agent, DEFAULT_CONFIG[agent], true);
  return { tenant: getTenant(id), api_key: apiKey };
}

export const getTenant = (id) => get('SELECT * FROM tenants WHERE id = ?', id);
export const getTenantByStore = (storeId) => get('SELECT * FROM tenants WHERE iflores_store_id = ?', storeId);
export const listTenants = () => all("SELECT * FROM tenants WHERE status = 'active'");
export const findTenantByApiKey = (key) => (key ? get('SELECT * FROM tenants WHERE api_key_hash = ?', sha256(key)) : null);

export function rotateApiKey(id) {
  const apiKey = 'ifa_' + crypto.randomBytes(24).toString('base64url');
  run('UPDATE tenants SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?', sha256(apiKey), apiKey.slice(0, 10), id);
  return apiKey;
}

/** Atualiza campos JSON do tenant (merge profundo). */
export function updateTenantData(id, patch) {
  const row = get('SELECT data FROM tenants WHERE id = ?', id);
  const current = row ? Object.fromEntries(Object.entries(row)) : {};
  const merged = mergeDeep(current, patch);
  delete merged.data;
  run('UPDATE tenants SET data = ? WHERE id = ?', JSON.stringify(merged), id);
  if (patch.name) run('UPDATE tenants SET name = ? WHERE id = ?', patch.name, id);
  return getTenant(id);
}

/** Visão pública do tenant (sem segredos). */
export function publicTenant(t) {
  if (!t) return null;
  const mask = (s) => (s ? s.slice(0, 4) + '••••' + s.slice(-4) : '');
  const integrations = Object.fromEntries(
    Object.entries(t.integrations || {}).map(([k, v]) => [k, { ...v, access_token: mask(v.access_token) }]),
  );
  return {
    id: t.id, name: t.name, iflores_store_id: t.iflores_store_id, plan: t.plan, status: t.status,
    api_key_prefix: t.api_key_prefix, created_at: t.created_at, brand: t.brand,
    iflores: { ...t.iflores, token: mask(t.iflores?.token) },
    integrations,
    webhook: { ...t.webhook, secret: t.webhook?.secret ? mask(t.webhook.secret) : '' },
  };
}

// ---------- configs dos agentes ----------
export function getAgentConfig(tenantId, agent) {
  const row = get('SELECT * FROM agent_configs WHERE tenant_id = ? AND agent = ?', tenantId, agent);
  if (!row) return { ...DEFAULT_CONFIG[agent], enabled: false };
  const { tenant_id, agent: _a, updated_at, ...cfg } = row;
  return { ...mergeDeep(DEFAULT_CONFIG[agent], cfg), enabled: !!row.enabled, updated_at };
}

export function saveAgentConfig(tenantId, agent, patch, enabled) {
  const current = get('SELECT * FROM agent_configs WHERE tenant_id = ? AND agent = ?', tenantId, agent);
  const { enabled: patchEnabled, updated_at, tenant_id, agent: _a, ...rest } = patch || {};
  const base = current ? getAgentConfig(tenantId, agent) : DEFAULT_CONFIG[agent];
  const { enabled: _e, updated_at: _u, ...baseCfg } = base;
  const merged = mergeDeep(baseCfg, rest);
  const en = enabled ?? patchEnabled ?? (current ? !!current.enabled : true);
  run(
    `INSERT INTO agent_configs (tenant_id, agent, enabled, data, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(tenant_id, agent) DO UPDATE SET enabled = excluded.enabled, data = excluded.data, updated_at = excluded.updated_at`,
    tenantId, agent, en ? 1 : 0, JSON.stringify(merged), now(),
  );
  return getAgentConfig(tenantId, agent);
}

// ---------- token do painel embutido (iframe dentro da iFlores) ----------
export function signPanelToken(tenantId, ttlSec = 60 * 60 * 12, extra = {}) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, exp: Math.floor(Date.now() / 1000) + ttlSec, ...extra })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPanelToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (data.exp < Date.now() / 1000) return null;
  return data;
}
