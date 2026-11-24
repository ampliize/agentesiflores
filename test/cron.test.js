// O endpoint de rotinas (chamado pelo n8n) exige o segredo do cron e roda para cada loja.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/core/store.js';
import { seedDemo } from '../src/core/seed.js';
import { createApp } from '../src/server/index.js';

process.env.CRON_SECRET = 'segredo-de-teste';
delete process.env.ANTHROPIC_API_KEY;
let server; let base;

before(async () => {
  server = createApp({ store: createMemoryStore() }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await seedDemo('Loja cron');
});
after(() => server.close());

test('cron de rotinas recusa quem não tem o segredo e roda para as lojas com ele', async () => {
  const semSegredo = await fetch(`${base}/api/cron/rotinas`, { method: 'POST' });
  assert.equal(semSegredo.status, 401);
  const errado = await fetch(`${base}/api/cron/rotinas`, { method: 'POST', headers: { authorization: 'Bearer errado' } });
  assert.equal(errado.status, 401);
  const ok = await fetch(`${base}/api/cron/rotinas`, { method: 'POST', headers: { authorization: 'Bearer segredo-de-teste' } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.lojas >= 1);
});
