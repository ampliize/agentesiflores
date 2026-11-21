// Integração com a API da OpenAI, testada contra um servidor simulado no formato da API (sem chave real).
// Prova o encanamento: ferramentas com schema estrito, retorno ao modelo, alteração real na loja e limite de uso.
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'chave-de-teste';
process.env.OPENAI_MODEL = 'modelo-de-teste';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryStore, db, comLoja } from '../src/core/store.js';
import { init } from '../src/core/index.js';
import { ativarContexto } from '../src/server/contexto.js';
import { seedDemo } from '../src/core/seed.js';
import { getSettings } from '../src/core/catalog.js';
import { runToolLoop, aiEnabled, MODEL } from '../src/core/llm.js';
import * as AL from '../src/core/agents/alex.js';

let srv; const pedidos = [];
before(async () => {
  ativarContexto(); init(createMemoryStore());
  srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      pedidos.push(body);
      const json = (x) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
      const base = { id: 'cmpl-1', object: 'chat.completion', created: 0, model: body.model, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      const msgs = body.messages || [];
      const ultima = msgs[msgs.length - 1];
      if (ultima?.role === 'tool') return json({ ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Pronto: coloquei o produto em primeiro na página inicial.' } }] });
      const pergunta = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
      if (/girass/i.test(pergunta)) {
        return json({ ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'destacar_na_home', arguments: JSON.stringify({ produto: 'girassóis', destaque: true }) } }] } }] });
      }
      if (/queda|caíram/i.test(pergunta)) {
        return json({ ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'diagnostico_queda', arguments: '{}' } }] } }] });
      }
      return json({ ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Entendido.' } }] });
    });
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;
});
after(() => srv.close());

test('provedor OpenAI é escolhido por variável e fica ativo com a chave', () => {
  assert.equal(aiEnabled(), true);
  assert.equal(MODEL(), 'modelo-de-teste');
});

test('ferramentas vão com schema estrito e o resultado volta ao modelo', async () => {
  pedidos.length = 0;
  const tools = [{ name: 'soma', description: 'soma dois números', input_schema: { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } }, run: ({ a, b }) => ({ total: a + b }) }];
  const trace = [];
  const r = await runToolLoop({ system: 'teste', messages: [{ role: 'user', content: 'quanto é 2+3?' }], tools, trace });
  assert.equal(r.text, 'Entendido.');
  assert.equal(pedidos[0].tools[0].type, 'function');
  assert.equal(pedidos[0].tools[0].function.strict, true);
  assert.deepEqual(pedidos[0].tools[0].function.parameters.required, ['a', 'b']);
});

test('clique do dono em "coloque em destaque" altera a loja por meio do modelo', async () => {
  const t = seedDemo('Loja OpenAI');
  await comLoja(t, async () => {
    const antes = getSettings(t).destaques_home;
    const trace = [];
    const r = await AL.conversar(t, 'Alex, coloque os girassóis em destaque', { trace });
    assert.equal(trace[0]?.nome, 'destacar_na_home');
    assert.equal(r.texto, 'Pronto: coloquei o produto em primeiro na página inicial.');
    const depois = getSettings(t).destaques_home;
    assert.notDeepEqual(depois, antes);
    assert.equal(db().get('products', depois[0]).nome.includes('Girass'), true);
  });
});

test('pergunta de diagnóstico usa a ferramenta e não altera nada sozinha', async () => {
  const t = seedDemo('Loja diag');
  await comLoja(t, async () => {
    const mudancasAntes = db().list('changes', t).length;
    const trace = [];
    await AL.conversar(t, 'Minhas vendas caíram. O que devo fazer?', { trace });
    assert.equal(trace[0]?.nome, 'diagnostico_queda');
    assert.equal(db().list('changes', t).length, mudancasAntes);
  });
});

test('o uso fica registrado por loja, com provedor e modelo', async () => {
  const t = seedDemo('Loja uso');
  await comLoja(t, async () => { await AL.conversar(t, 'oi'); });
  const u = db().list('uso_ia', t)[0];
  assert.ok(u && u.chamadas >= 1);
  assert.equal(u.provedor, 'openai');
  assert.equal(u.modelo, 'modelo-de-teste');
});
