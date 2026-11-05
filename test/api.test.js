// Testes de ponta a ponta da API aberta (modo demonstração, sem chave de IA).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iflores-'));
process.env.DB_PATH = ':memory:';
process.env.MEDIA_DIR = path.join(tmp, 'media');
process.env.IFLORES_PLATFORM_KEY = 'plat-test';
process.env.APP_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;

const { createApp } = await import('../src/server.js');
const { evaluateRules } = await import('../src/agents/trafego.js');
let server; let base; let apiKey; let token; let storeId = 'loja-123';

const call = async (p, { method = 'GET', body, auth = apiKey, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => { server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('plataforma cria loja e gera sessão do painel', async () => {
  assert.equal((await call('/api/v1/platform/tenants', { method: 'POST', auth: null, body: { name: 'X' } })).status, 401);
  const r = await call('/api/v1/platform/tenants', { method: 'POST', auth: null, headers: { 'x-platform-key': 'plat-test' }, body: { name: 'Flores da Ana', iflores_store_id: storeId } });
  assert.equal(r.status, 201);
  assert.match(r.body.api_key, /^ifa_/);
  apiKey = r.body.api_key;
  const s = await call(`/api/v1/platform/tenants/${storeId}/session`, { method: 'POST', auth: null, headers: { 'x-platform-key': 'plat-test' } });
  assert.equal(s.status, 200);
  token = s.body.token;
  assert.ok(s.body.panel_url.includes('/painel?token='));
});

test('autenticação por chave de API e por token do painel', async () => {
  assert.equal((await call('/api/v1/me', { auth: 'ifa_errada' })).status, 401);
  assert.equal((await call('/api/v1/me')).body.tenant.name, 'Flores da Ana');
  assert.equal((await call('/api/v1/me', { auth: token })).status, 200);
});

test('configuração dos agentes é personalizável', async () => {
  const r = await call('/api/v1/agents/social/config', { method: 'PUT', body: { posts_feed_semana: 2, stories_dia: 1, criativos_anuncio_semana: 1 } });
  assert.equal(r.body.posts_feed_semana, 2);
  assert.equal(r.body.tom, 'acolhedor, romântico e elegante'); // mantém o resto
  assert.equal((await call('/api/v1/agents/xyz/config')).status, 404);
});

test('atendente responde no simulador com produtos reais do catálogo', async () => {
  const r = await call('/api/v1/chat', { method: 'POST', body: { text: 'quero rosas vermelhas', contact: '5511999990000' } });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /Rosas/);
  const m = await call(`/api/v1/conversations/${r.body.conversation_id}/messages`);
  assert.equal(m.body.messages.length, 2);
});

test('social media gera artes e o gerente revisa', async () => {
  const r = await call('/api/v1/agents/social/run', { method: 'POST', body: {} });
  assert.equal(r.body.result.length, 2 + 7 + 1);
  const post = r.body.result[0];
  assert.equal(post.status, 'revisao_gerente');
  assert.equal((await fetch(base + post.image_url)).status, 200);
  await call('/api/v1/agents/gerente/run', { method: 'POST', body: {} });
  const after = await call('/api/v1/posts');
  assert.ok(after.body.some((p) => p.revisao_gerente));
  const ap = await call(`/api/v1/posts/${post.id}/approve`, { method: 'POST', body: {} });
  assert.ok(['agendado', 'aprovado'].includes(ap.body.status));
});

test('tráfego pausa campanha sem conversão e escala a que vende', async () => {
  const r = await call('/api/v1/agents/trafego/run', { method: 'POST', body: {} });
  const acoes = r.body.result.decisoes.map((d) => `${d.acao}:${d.campanha}`);
  assert.ok(acoes.includes('pausar:Girassóis - Alcance Bairros'));
  assert.ok(acoes.some((a) => a.startsWith('escalar:')));
  const c = await call('/api/v1/campaigns');
  assert.equal(c.body.campaigns.find((x) => x.name === 'Girassóis - Alcance Bairros').status, 'pausada');
});

test('regras de tráfego respeitam a configuração do dono', () => {
  const cfg = { cpa_maximo: 30, roas_minimo: 3, regras: { pausar_sem_conversao_apos_gasto: 50, pausar_ctr_abaixo: 1, escalar_roas_acima: 5, percentual_escala: 20 } };
  const base = { status: 'ativa', impressoes: 5000, ctr: 2, orcamento_diario: 50 };
  const d = evaluateRules([
    { ...base, name: 'a', gasto: 80, conversoes: 0, roas: 0 },
    { ...base, name: 'b', gasto: 80, conversoes: 10, roas: 6, cpa: 8 },
    { ...base, name: 'c', gasto: 80, conversoes: 1, roas: 1, cpa: 80 },
    { ...base, name: 'd', status: 'pausada', gasto: 999, conversoes: 0 },
  ], cfg);
  assert.deepEqual(d.map((x) => [x.campanha.name, x.acao]), [['a', 'pausar'], ['b', 'escalar'], ['c', 'pausar']]);
  assert.equal(d[1].novo_orcamento, 60);
});

test('tarefas, eventos da iFlores e visão da equipe', async () => {
  const t = await call('/api/v1/tasks', { method: 'POST', body: { agent: 'social', title: 'Post sobre orquídeas' } });
  assert.equal(t.status, 201);
  const ev = await call('/api/v1/events', { method: 'POST', body: { type: 'product.out_of_stock', data: { id: 'p1', nome: 'Buquê' } } });
  assert.equal(ev.status, 202);
  const tasks = await call('/api/v1/tasks?agent=trafego');
  assert.ok(tasks.body.some((x) => x.title.includes('sem estoque')));
  const team = await call('/api/v1/team');
  assert.deepEqual(team.body.team.map((a) => a.key), ['gerente', 'trafego', 'social', 'atendente']);
  assert.ok(team.body.kpis.items.length >= 5);
});
