// CRM sincronizado com a iFlores (servidor falso) e automações com suas proteções.
import { test, before, after } from 'node:test';
import { setHired } from '../src/core/team.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryStore, db, comLoja } from '../src/core/store.js';
import { init } from '../src/core/index.js';
import { ativarContexto } from '../src/server/contexto.js';
import { seedDemo } from '../src/core/seed.js';
import { handle } from '../src/core/api.js';
import * as crm from '../src/core/crm.js';
import * as aut from '../src/core/automacoes.js';
import { localTime } from '../src/core/util.js';

delete process.env.ANTHROPIC_API_KEY;
let t; let srv; let recebido; let falhar = 0;
const api = (method, path, body) => comLoja(t, () => handle({ method, path, body, tenantId: t })).then((r) => r.body);
// um horário comercial próximo (as mensagens de marketing respeitam o horário de silêncio)
function horarioComercial() { let d = new Date(); for (let i = 0; i < 48; i++) { const h = localTime(d); if (h >= '10:00' && h < '19:00') return d; d = new Date(d.getTime() + 30 * 60e3); } return d; }

before(async () => {
  ativarContexto(); init(createMemoryStore()); t = seedDemo(); setHired(t, 'flora', true);
  recebido = { clientes: [], pedidos: [], alteracoes: [] };
  srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const json = (code, x) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
      if (req.headers.authorization !== 'Bearer tok-loja') return json(401, {});
      if (falhar > 0) { falhar--; return json(503, { erro: 'fora do ar' }); }
      if (req.url.startsWith('/v1/sync')) return json(200, { cursor: 'c2', clientes: [{ id: 'C9', telefone: '(11) 97000-1234', nome: 'Helena Prado', aceita_marketing: true }], pedidos: [{ id: 'P77', numero: 7700, telefone: '11970001234', cliente_nome: 'Helena Prado', itens: [{ nome: 'Buquê Paz', preco: 189.9, qtd: 1 }], total: 189.9, status: 'pago', pago: true }] });
      if (req.url.startsWith('/v1/customers')) { recebido.clientes.push(JSON.parse(b)); return json(200, { id: `C${recebido.clientes.length + 100}` }); }
      if (req.url === '/v1/orders') { recebido.pedidos.push(JSON.parse(b)); return json(200, { id: `P${recebido.pedidos.length + 500}` }); }
      if (req.url === '/v1/changes') { recebido.alteracoes.push(JSON.parse(b)); return json(200, { ok: true }); }
      return json(404, {});
    });
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
});
after(() => srv.close());

test('CRM: contatos com etapa do funil e linha do tempo', async () => {
  const f = await api('GET', '/crm/funil');
  assert.ok(f.contagem.cliente >= 1 && f.contagem.aguardando_pagamento >= 1);
  const c = (await api('GET', '/crm/contatos')).find((x) => x.nome === 'Juliana Costa');
  const tl = await api('GET', `/crm/contatos/${c.contato}`);
  assert.ok(tl.eventos.some((e) => e.tipo === 'mensagem'));
  await api('POST', `/crm/contatos/${c.contato}/notas`, { texto: 'Prefere entrega à tarde' });
  assert.ok((await api('GET', `/crm/contatos/${c.contato}`)).eventos.some((e) => e.tipo === 'nota'));
});

test('CRM: sem conexão, nada se perde; ao conectar, recebe da iFlores e envia a fila', async () => {
  await api('POST', '/atendimento/mensagem', { canal: 'simulador', contato: '5511955550000', nome: 'Rita', texto: 'oi' });
  assert.ok(crm.estadoSync(t).fila_pendente > 0, 'contato novo aguarda na fila');
  const tn = db().get('tenants', t);
  db().put('tenants', { ...tn, iflores: { base_url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-loja', connected: true } });
  await api('POST', '/crm/sincronizar');
  const helena = crm.getContato(t, '5511970001234');
  assert.equal(helena.nome, 'Helena Prado'); assert.equal(helena.external_id, 'C9');
  assert.equal(helena.optin_marketing, true);
  assert.equal(db().list('orders', t, (o) => o.external_id === 'P77').length, 1);
  await api('POST', '/crm/sincronizar');
  assert.equal(db().list('orders', t, (o) => o.external_id === 'P77').length, 1, 'sincronizar de novo não duplica');
  assert.ok(recebido.clientes.some((c) => c.telefone === '5511955550000'), 'contato criado pela Flora chegou na iFlores');
  assert.ok(recebido.clientes.length > 0);
});

test('CRM: iFlores fora do ar → nova tentativa depois, sem perder o envio', async () => {
  await api('PATCH', '/crm/contatos/5511955550000', { email: 'rita@exemplo.com' });
  falhar = 1;
  const r1 = await comLoja(t, () => crm.processarFila(t));
  assert.equal(r1.enviados, 0);
  const item = db().list('outbox', t, (o) => o.chave === 'cliente:5511955550000' && o.status === 'pendente')[0];
  assert.equal(item.tentativas, 1); assert.ok(item.proxima_em > new Date().toISOString());
  const r2 = await comLoja(t, () => crm.processarFila(t, new Date(Date.now() + 10 * 60e3)));
  assert.ok(r2.enviados >= 1);
  assert.ok(recebido.clientes.some((c) => c.email === 'rita@exemplo.com'));
});

test('Automações: enviam uma vez, respeitam consentimento e quem está com atendente humano', async () => {
  const agora = horarioComercial();
  await comLoja(t, () => aut.executarAutomacoes(t, agora));
  await comLoja(t, () => aut.executarAutomacoes(t, agora));
  const ex = aut.listarExecucoes(t, 300);
  const por = (m) => ex.filter((e) => e.modelo === m);
  assert.equal(por('pagamento_pendente').filter((e) => e.status === 'enviado').length, 1, 'lembrete de pagamento só uma vez');
  assert.equal(por('pos_venda').filter((e) => e.status === 'enviado').length, 1);
  assert.ok(por('data_especial').some((e) => e.status === 'enviado' && /Renata/.test(e.texto)));
  assert.ok(por('data_especial').some((e) => e.status === 'pulado' && /consentimento/.test(e.motivo)), 'sem opt-in não recebe marketing');
  assert.ok(por('conversa_parada').some((e) => e.status === 'enviado'));
  assert.ok(por('estoque_baixo').length >= 1);
  // pagamento confirmado → mensagem automática
  const o = db().list('orders', t, (x) => x.status === 'aguardando_pagamento')[0];
  await api('POST', '/eventos', { id: 'e1', type: 'payment.confirmed', data: { order_id: o.id } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(aut.listarExecucoes(t).some((e) => e.modelo === 'pagamento_confirmado' && e.status === 'enviado'));
  // desligar uma automação para a loja
  await api('PUT', '/automacoes/pos_venda', { ativo: false });
  assert.equal((await api('GET', '/automacoes')).find((a) => a.id === 'pos_venda').ativo, false);
});

test('Automações não falam com cliente que está com uma pessoa da loja', async () => {
  const conv = db().list('conversations', t, (c) => c.nome === 'Juliana Costa')[0];
  const marco = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await api('POST', `/atendimento/conversas/${encodeURIComponent(conv.id)}/assumir`, { texto: 'Oi Juliana, aqui é a Ana' });
  db().put('conversations', { ...db().get('conversations', conv.id), ultima_cliente_em: new Date(Date.now() - 3 * 3600e3).toISOString() });
  await comLoja(t, () => aut.executarAutomacoes(t, horarioComercial()));
  assert.ok(aut.listarExecucoes(t, 300).some((e) => e.modelo === 'conversa_parada' && e.status === 'pulado' && /pessoa/.test(e.motivo)));
  const enviadasDepois = db().list('messages', t, (m) => m.conversation_id === conv.id && m.role === 'flora' && m.em > marco);
  assert.equal(enviadasDepois.length, 0);
});
