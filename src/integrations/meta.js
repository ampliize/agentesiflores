// Meta Marketing API (Ads) + Instagram Graph API (publicação).
// Sem credenciais, geramos campanhas de demonstração com métricas simuladas
// para que o Gestor de Tráfego possa ser testado no painel.
import { all, run, now, uid } from '../db.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(token, method, path, params = {}) {
  const url = new URL(GRAPH + path);
  const opts = { method, signal: AbortSignal.timeout(15000) };
  if (method === 'GET') { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v); url.searchParams.set('access_token', token); }
  else { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify({ ...params, access_token: token }); }
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta API ${path}: ${json?.error?.message || res.status}`);
  return json;
}

// ---------------- Ads ----------------
export class MetaAds {
  constructor(tenant) {
    this.tenant = tenant;
    this.cfg = tenant?.integrations?.meta_ads || {};
    this.demo = !(this.cfg.connected && this.cfg.ad_account_id && this.cfg.access_token);
  }

  /** Lista campanhas com métricas dos últimos 7 dias. */
  async campaignsWithInsights() {
    if (this.demo) return this.#demoCampaigns();
    const act = this.cfg.ad_account_id.startsWith('act_') ? this.cfg.ad_account_id : `act_${this.cfg.ad_account_id}`;
    const camps = await graph(this.cfg.access_token, 'GET', `/${act}/campaigns`, {
      fields: 'id,name,status,objective,daily_budget,insights.date_preset(last_7d){spend,impressions,clicks,ctr,cpc,actions,action_values,purchase_roas}',
      limit: 50,
    });
    return (camps.data || []).map((c) => {
      const i = c.insights?.data?.[0] || {};
      const purchases = Number((i.actions || []).find((a) => a.action_type === 'purchase' || a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0);
      const revenue = Number((i.action_values || []).find((a) => a.action_type === 'purchase')?.value || 0);
      const spend = Number(i.spend || 0);
      return {
        external_id: c.id, name: c.name, status: c.status === 'ACTIVE' ? 'ativa' : 'pausada', objetivo: c.objective,
        orcamento_diario: Number(c.daily_budget || 0) / 100, gasto: spend, impressoes: Number(i.impressions || 0),
        cliques: Number(i.clicks || 0), ctr: Number(i.ctr || 0), conversoes: purchases, receita: revenue,
        roas: spend ? revenue / spend : 0, cpa: purchases ? spend / purchases : null,
      };
    });
  }

  async pause(externalId) {
    if (this.demo) return this.#demoUpdate(externalId, { status: 'pausada' });
    return graph(this.cfg.access_token, 'POST', `/${externalId}`, { status: 'PAUSED' });
  }

  async setDailyBudget(externalId, value) {
    if (this.demo) return this.#demoUpdate(externalId, { orcamento_diario: value });
    return graph(this.cfg.access_token, 'POST', `/${externalId}`, { daily_budget: Math.round(value * 100) });
  }

  /** Cria campanha (pausada por segurança se o dono exigir aprovação). */
  async createCampaign({ nome, objetivo = 'OUTCOME_SALES', orcamento_diario, ativa = false }) {
    if (this.demo) {
      const c = { external_id: 'demo_' + uid(), name: nome, status: ativa ? 'ativa' : 'pausada', objetivo, orcamento_diario, gasto: 0, impressoes: 0, cliques: 0, ctr: 0, conversoes: 0, receita: 0, roas: 0, cpa: null, criada_pelo_agente: true };
      run('INSERT INTO campaigns (id, tenant_id, external_id, name, status, data, updated_at) VALUES (?,?,?,?,?,?,?)', uid('cmp_'), this.tenant.id, c.external_id, nome, c.status, JSON.stringify(c), now());
      return c;
    }
    const act = this.cfg.ad_account_id.startsWith('act_') ? this.cfg.ad_account_id : `act_${this.cfg.ad_account_id}`;
    return graph(this.cfg.access_token, 'POST', `/${act}/campaigns`, {
      name: nome, objective: objetivo, status: ativa ? 'ACTIVE' : 'PAUSED', special_ad_categories: [], daily_budget: Math.round(orcamento_diario * 100),
    });
  }

  #demoCampaigns() {
    let rows = all('SELECT * FROM campaigns WHERE tenant_id = ?', this.tenant.id);
    if (!rows.length) {
      const seed = [
        ['Rosas - Conversão Site', 'ativa', 40, 212, 9100, 182, 2.0, 9, 1710],
        ['Remarketing Carrinho', 'ativa', 20, 98, 4100, 131, 3.2, 6, 1140],
        ['Girassóis - Alcance Bairros', 'ativa', 25, 118, 15200, 91, 0.6, 0, 0],
        ['WhatsApp - Mensagens', 'ativa', 30, 151, 7800, 160, 2.05, 5, 820],
      ];
      for (const [name, status, budget, spend, imp, clicks, ctr, conv, rev] of seed) {
        const c = { external_id: 'demo_' + uid(), name, status, objetivo: 'OUTCOME_SALES', orcamento_diario: budget, gasto: spend, impressoes: imp, cliques: clicks, ctr, conversoes: conv, receita: rev, roas: spend ? rev / spend : 0, cpa: conv ? spend / conv : null };
        run('INSERT INTO campaigns (id, tenant_id, external_id, name, status, data, updated_at) VALUES (?,?,?,?,?,?,?)', uid('cmp_'), this.tenant.id, c.external_id, name, status, JSON.stringify(c), now());
      }
      rows = all('SELECT * FROM campaigns WHERE tenant_id = ?', this.tenant.id);
    }
    return rows;
  }

  #demoUpdate(externalId, patch) {
    const row = all('SELECT * FROM campaigns WHERE tenant_id = ? AND external_id = ?', this.tenant.id, externalId)[0];
    if (!row) throw new Error('Campanha não encontrada');
    const { id, tenant_id, updated_at, ...data } = row;
    const merged = { ...data, ...patch };
    run('UPDATE campaigns SET status = ?, data = ?, updated_at = ? WHERE id = ?', merged.status, JSON.stringify(merged), now(), id);
    return merged;
  }
}

/** Sincroniza o cache local de campanhas (para o painel) a partir da Meta. */
export function cacheCampaigns(tenantId, list) {
  for (const c of list) {
    const existing = all('SELECT id FROM campaigns WHERE tenant_id = ? AND external_id = ?', tenantId, c.external_id)[0];
    if (existing) run('UPDATE campaigns SET name = ?, status = ?, data = ?, updated_at = ? WHERE id = ?', c.name, c.status, JSON.stringify(c), now(), existing.id);
    else run('INSERT INTO campaigns (id, tenant_id, external_id, name, status, data, updated_at) VALUES (?,?,?,?,?,?,?)', uid('cmp_'), tenantId, c.external_id, c.name, c.status, JSON.stringify(c), now());
  }
}

// ---------------- Instagram ----------------
export async function publishInstagram(tenant, { image_url, caption, format }) {
  const ig = tenant?.integrations?.instagram;
  if (!ig?.connected || !ig.ig_user_id || !ig.access_token) return { demo: true, id: 'demo_media_' + uid() };
  const container = await graph(ig.access_token, 'POST', `/${ig.ig_user_id}/media`, {
    image_url, ...(format === 'story' ? { media_type: 'STORIES' } : { caption }),
  });
  const published = await graph(ig.access_token, 'POST', `/${ig.ig_user_id}/media_publish`, { creation_id: container.id });
  return { id: published.id };
}
