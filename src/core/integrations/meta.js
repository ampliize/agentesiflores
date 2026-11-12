// Meta (Instagram e Ads) e Google Ads. Sem conta conectada, nada sai daqui (modo demonstração).
const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(token, method, path, params = {}) {
  const url = new URL(GRAPH + path);
  const opts = { method, signal: AbortSignal.timeout(15000) };
  if (method === 'GET') { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v); url.searchParams.set('access_token', token); }
  else { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify({ ...params, access_token: token }); }
  const res = await fetch(url, opts); const json = await res.json();
  if (!res.ok) throw new Error(`Meta API ${path}: ${json?.error?.message || res.status}`);
  return json;
}

/** Publica no Instagram (feed, carrossel ou story). Retorna { demo: true } sem conta conectada. */
export async function publishInstagram(tenant, { image_url, caption, format }) {
  const ig = tenant?.integrations?.instagram;
  if (!ig?.connected || !ig.ig_user_id || !ig.access_token) return { demo: true, id: `demo_${Date.now()}` };
  const container = await graph(ig.access_token, 'POST', `/${ig.ig_user_id}/media`, { image_url, ...(format === 'story_sequencia' ? { media_type: 'STORIES' } : { caption }) });
  const published = await graph(ig.access_token, 'POST', `/${ig.ig_user_id}/media_publish`, { creation_id: container.id });
  return { id: published.id };
}

/** Insights de campanhas Meta (últimos 7 dias), no formato usado pelo Caio. */
export async function metaCampaigns(tenant) {
  const m = tenant?.integrations?.meta_ads;
  if (!m?.connected) return null;
  const act = m.ad_account_id.startsWith('act_') ? m.ad_account_id : `act_${m.ad_account_id}`;
  const r = await graph(m.access_token, 'GET', `/${act}/campaigns`, { fields: 'id,name,status,daily_budget,insights.date_preset(last_7d){spend,impressions,clicks,ctr,actions,action_values}', limit: 50 });
  return (r.data || []).map((c) => {
    const i = c.insights?.data?.[0] || {};
    const compras = Number((i.actions || []).find((a) => a.action_type === 'purchase')?.value || 0);
    const receita = Number((i.action_values || []).find((a) => a.action_type === 'purchase')?.value || 0);
    const gasto = Number(i.spend || 0);
    return { external_id: c.id, plataforma: 'meta', nome: c.name, status: c.status === 'ACTIVE' ? 'ativa' : 'pausada', orcamento_diario: Number(c.daily_budget || 0) / 100, metricas: { gasto, impressoes: Number(i.impressions || 0), cliques: Number(i.clicks || 0), ctr: Number(i.ctr || 0), compras, receita, roas: gasto ? receita / gasto : 0 } };
  });
}

export async function metaSetStatus(tenant, externalId, ativa) {
  const m = tenant?.integrations?.meta_ads; if (!m?.connected) return { demo: true };
  return graph(m.access_token, 'POST', `/${externalId}`, { status: ativa ? 'ACTIVE' : 'PAUSED' });
}
