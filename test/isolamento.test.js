// REGRA DO PRODUTO: nenhuma loja pode ver, alterar ou receber dados de outra.
// Estes testes provam o isolamento na camada de dados, na API, nos agentes e sob carga (1000 lojas).
import { test, before } from 'node:test';
import { setHired } from '../src/core/team.js';
import assert from 'node:assert/strict';
import { createMemoryStore, db, comLoja, IsolationError } from '../src/core/store.js';
import { init } from '../src/core/index.js';
import { ativarContexto } from '../src/server/contexto.js';
import { seedDemo } from '../src/core/seed.js';
import { handle } from '../src/core/api.js';
import { receberMensagem } from '../src/core/agents/flora.js';
import { DEFAULT_SETTINGS } from '../src/core/catalog.js';
import { brl } from '../src/core/util.js';

delete process.env.ANTHROPIC_API_KEY;
let A; let B;
const api = (t, method, path, body) => comLoja(t, () => handle({ method, path, body, tenantId: t }));
const primeiro = async (p) => (await p)[0];

before(async () => { ativarContexto(); init(createMemoryStore()); A = await seedDemo('Loja A'); B = await seedDemo('Loja B'); await setHired(A, 'flora', true); await setHired(B, 'flora', true); });

test('camada de dados recusa ler, listar, gravar ou apagar dados de outra loja', async () => {
  const produtoB = await primeiro(db().list('products', B));
  await comLoja(A, async () => {
    await assert.rejects(async () => db().get('products', produtoB.id), IsolationError);
    await assert.rejects(async () => db().list('products', B), IsolationError);
    await assert.rejects(async () => db().list('products', null), IsolationError);
    await assert.rejects(async () => db().put('products', { ...produtoB, preco: 1 }), IsolationError);
    await assert.rejects(async () => db().put('products', { ...produtoB, tenant_id: A }), IsolationError, 'não dá para "roubar" um documento trocando o tenant_id');
    await assert.rejects(async () => db().del('products', produtoB.id), IsolationError);
    await assert.rejects(async () => comLoja(B, async () => 1), IsolationError, 'não dá para trocar de loja dentro de um contexto');
  });
  assert.equal((await db().get('products', produtoB.id)).preco, produtoB.preco);
});

test('API de uma loja não enxerga registros da outra (responde 404)', async () => {
  await api(B, 'POST', '/atendimento/mensagem', { canal: 'simulador', contato: '5511900000001', texto: 'oi' });
  const convB = await primeiro(db().list('conversations', B));
  await api(B, 'POST', '/tarefas', { responsavel: 'mari', titulo: 'Post da loja B' });
  const taskB = await primeiro(db().list('tasks', B));
  const r1 = await api(A, 'GET', `/atendimento/conversas/${encodeURIComponent(convB.id)}`);
  assert.equal(r1.status, 404);
  const r2 = await api(A, 'PATCH', `/tarefas/${taskB.id}`, { status: 'concluida' });
  assert.equal(r2.status, 404);
  assert.notEqual((await db().get('tasks', taskB.id)).status, 'concluida');
  const r3 = await api(A, 'GET', '/crm/contatos/5511900000001');
  assert.equal(r3.status, 404, 'contato da loja B não existe na loja A');
  const feedA = (await api(A, 'GET', '/atividade')).body;
  assert.ok(feedA.every((x) => x.tenant_id === A));
});

test('ações de agentes numa loja não mudam nada na outra', async () => {
  const antesB = (await db().list('products', B)).map((p) => [p.id, p.ativo]);
  const campB = (await db().list('campaigns', B)).map((c) => [c.id, c.status]);
  await api(A, 'POST', '/agentes/alex/conversar', { texto: 'Acabou a rosa vermelha. Desative os produtos que usam essa flor.' });
  assert.ok((await db().list('products', A)).some((p) => !p.ativo));
  assert.deepEqual((await db().list('products', B)).map((p) => [p.id, p.ativo]), antesB);
  assert.deepEqual((await db().list('campaigns', B)).map((c) => [c.id, c.status]), campB);
});

test('1000 lojas atendendo ao mesmo tempo: cada cliente recebe só os produtos e preços da própria loja', async () => {
  const N = 1000; const lojas = [];
  for (let i = 0; i < N; i++) {
    const t = `loja_carga_${i}`;
    await db().put('tenants', { id: t, tenant_id: t, name: `Floricultura ${i}`, status: 'active', plano: { agentes: { flora: true } }, integrations: {} });
    await db().put('settings', { ...DEFAULT_SETTINGS, id: t, tenant_id: t, fretes: [{ bairro: 'Centro', valor: 10, ativo: true }] });
    // todas as lojas têm um produto com o MESMO nome, mas preço diferente
    await db().put('products', { id: `${t}:buque`, tenant_id: t, nome: 'Buquê da Casa', preco: 100 + i, descricao: `Buquê exclusivo da loja ${i}.`, categoria: 'Buquês', tipo: 'produto', ativo: true, estoque: null, tags: [], composicao: [] });
    lojas.push(t);
  }
  const inicio = Date.now();
  const respostas = await Promise.all(lojas.map((t, i) => comLoja(t, () => receberMensagem(t, { canal: 'simulador', contato: '5511999990000', nome: 'Mesmo cliente', texto: 'quero um buquê' })).then((r) => ({ t, i, r }))));
  const ms = Date.now() - inicio;
  for (const { t, i, r } of respostas) {
    const precoCerto = brl(100 + i);
    assert.ok(r.resposta.includes(precoCerto), `loja ${i} deveria mostrar ${precoCerto}: ${r.resposta}`);
    assert.ok(r.resposta.includes(`Floricultura ${i}`), `loja ${i} deveria se apresentar com o próprio nome`);
    const outros = r.resposta.match(/R\$ [\d.]+,\d{2}/g).filter((x) => x !== precoCerto);
    assert.deepEqual(outros, [], `loja ${i} recebeu preço de outra loja`);
    assert.equal((await db().list('conversations', t)).length, 1);
    assert.ok((await db().list('messages', t)).every((m) => m.tenant_id === t));
  }
  // o mesmo telefone existe em 1000 lojas como 1000 contatos separados
  let total = 0;
  for (const t of lojas) total += (await db().list('customers', t)).length;
  assert.equal(total, N);
  console.log(`1000 lojas atendidas em ${ms} ms, sem mistura de dados`);
});

test('eventos repetidos da iFlores são processados uma única vez por loja', async () => {
  const o = await primeiro((await db().list('orders', A)).filter((x) => x.status === 'aguardando_pagamento'));
  const ev = { id: 'evt-123', type: 'payment.confirmed', data: { order_id: o.id } };
  await api(A, 'POST', '/eventos', ev);
  const r2 = await api(A, 'POST', '/eventos', ev);
  assert.equal(r2.body.duplicado, true);
  // o mesmo id de evento em outra loja é outro evento
  const oB = await primeiro((await db().list('orders', B)).filter((x) => x.status === 'aguardando_pagamento'));
  const rB = await api(B, 'POST', '/eventos', { ...ev, data: { order_id: oB.id } });
  assert.notEqual(rB.body.duplicado, true);
  // e uma loja não confirma pagamento de pedido de outra
  const cruzado = await api(A, 'POST', '/eventos', { id: 'evt-x', type: 'payment.confirmed', data: { order_id: oB.id } });
  assert.equal(cruzado.status, 404);
});
