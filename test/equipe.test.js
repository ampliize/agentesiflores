// Testes dos comportamentos pedidos para a Equipe dos Sonhos (modo demonstração, sem IA).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, db } from '../src/core/store.js';
import { seedDemo } from '../src/core/seed.js';
import { handle } from '../src/core/api.js';
import { createApp } from '../src/server/index.js';
import { getProduct, getSettings, verificarData } from '../src/core/catalog.js';
import { precoSugerido } from '../src/core/finance.js';
import { setHired } from '../src/core/team.js';
import { addDays, localDate, weekday } from '../src/core/util.js';

delete process.env.ANTHROPIC_API_KEY;
process.env.IFLORES_PLATFORM_KEY = 'plat';
let t; let server; let base;
const primeiro = async (p) => (await p)[0];
const call = async (method, path, body) => { const [p, qs] = path.split('?'); return (await handle({ method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), body, tenantId: t })).body; };
const alex = (texto) => call('POST', '/agentes/alex/conversar', { texto });
const sol = (texto) => call('POST', '/agentes/sol/conversar', { texto });
const cliente = (texto, contato = '5511911112222') => call('POST', '/atendimento/mensagem', { canal: 'simulador', contato, texto });

before(async () => { server = createApp({ store: createMemoryStore() }).listen(0); base = `http://127.0.0.1:${server.address().port}`; t = await seedDemo(); await setHired(t, 'flora', true); });
after(() => server.close());

test('Alex desativa produtos por flor (composição, nome ou descrição), explica e avisa a equipe', async () => {
  const r = await alex('Alex, acabou a rosa vermelha. Desative os produtos que usam essa flor.');
  assert.match(r.texto, /Desativei 5 produto/);
  assert.match(r.texto, /pela descrição/);
  assert.match(r.texto, /podem ter ficado de fora/);
  assert.equal((await getProduct(`${t}:encanto`)).ativo, false);
  const camp = await primeiro((await db().list('campaigns', t)).filter((c) => c.nome.startsWith('Rosas')));
  assert.equal(camp.status, 'pausada', 'Caio pausa anúncios do produto indisponível');
  const flora = await cliente('quero um buquê de rosas vermelhas');
  assert.doesNotMatch(flora.resposta, /Encanto/, 'Flora não oferece produto desativado');
});

test('Alex: alteração tem histórico e pode ser desfeita', async () => {
  const r = await alex('Desfaça a última alteração');
  assert.match(r.texto, /Desfiz/);
  assert.equal((await getProduct(`${t}:encanto`)).ativo, true);
  const alts = await call('GET', '/loja/alteracoes');
  assert.ok(alts.some((c) => c.revertida));
});

test('Alex: bloqueio de entrega só no dia pedido; pergunta quando há ambiguidade', async () => {
  const r = await alex('No dia 7 não teremos entregas, mas podemos receber pedidos para os outros dias.');
  assert.match(r.texto, /sem entregas/);
  const b = (await getSettings(t)).datas_bloqueadas[0];
  assert.equal(b.entrega, true); assert.equal(b.pedidos, false);
  assert.equal((await verificarData(t, b.data, 'entrega')).ok, false);
  assert.equal((await verificarData(t, addDays(b.data, 1), 'entrega')).ok, true);
  assert.match((await alex('Atualize o estoque deste produto para 15 unidades')).texto, /Para qual produto/);
  assert.match((await alex('Orquídea')).texto, /Orquídea Phalaenopsis Branca para 15/);
  assert.match((await alex('Configure o frete desse bairro para R$12')).texto, /Qual é o bairro/);
  assert.match((await alex('Brooklin')).texto, /Brooklin com frete de R\$ 12,00/);
  assert.match((await alex('Ative o catálogo de data comemorativa do dia 10 ao dia 12')).texto, /Ativei o catálogo/);
});

test('Alex respeita permissões', async () => {
  await call('PUT', '/agentes/alex/config', { permissoes: { fretes: false } });
  assert.match((await alex('Configure o frete de Moema para R$20')).texto, /permissão/);
  await call('PUT', '/agentes/alex/config', { permissoes: { fretes: true } });
});

test('Recomendações do Alex trazem dado, interpretação, autorização e acompanhamento; a aprovada roda', async () => {
  const recs = await call('GET', '/alex/recomendacoes');
  assert.ok(recs.length >= 2);
  for (const r of recs) { assert.ok(r.recomendacao.dado && r.recomendacao.interpretacao && r.recomendacao.acompanhamento); }
  const exec = recs.find((r) => r.recomendacao.autorizacao.acao?.acao === 'definir_destaques');
  assert.ok(exec);
  await call('POST', `/tarefas/${exec.id}/aprovar`);
  assert.equal((await getSettings(t)).destaques_home[0], exec.recomendacao.autorizacao.acao.params.ids[0]);
});

test('Sugestão de compras é estimativa e mostra limitações', async () => {
  const c = await call('GET', '/alex/compras');
  assert.ok(c.linhas.length > 0);
  assert.match(c.aviso, /não uma quantidade exata/);
  assert.ok(c.limitacoes.some((l) => /sem composição/.test(l)));
});

test('Sol: preço com premissas, desconto e diagnóstico de margem', async () => {
  const p = await sol('Meu buquê custa R$50 para produzir. Por quanto posso vender?');
  assert.match(p.texto, /Premissas/); assert.match(p.texto, /não é o lucro líquido/);
  const r = await precoSugerido(t, { custo: 50, margemAlvoPct: 15 });
  assert.ok(r.minimo < r.equilibrio && r.equilibrio < r.sugerido);
  const d = await sol('Posso dar 10% de desconto no Buquê Primavera?');
  assert.match(d.texto, /precisaria vender/);
  const g = await sol('Por que estou vendendo mais e sobrando menos?');
  assert.match(g.texto, /margem baixa/); assert.match(g.texto, /descontos subiram/);
  await call('PUT', '/financas', { custos_fixos: [] });
  assert.match((await sol('Meu buquê custa R$40. Por quanto posso vender?')).texto, /Cálculo parcial/);
});

const diaSeguro = weekday(addDays(localDate(), 1)) === 'dom' ? 'depois de amanhã' : 'amanhã';
test('Flora: resumo antes do pedido, link sem duplicar, pagamento só pelo sistema', async () => {
  const c = '5511955554444';
  for (const m of ['quero flores para o aniversário da minha mãe, até 200', 'a orquídea', 'não', 'entrega', diaSeguro, 'de tarde', 'Rua Afonso Celso, 100 - Vila Mariana', 'Dona Célia', 'Parabéns, mãe!']) await cliente(m, c);
  const resumo = await cliente('Marina', c);
  assert.match(resumo.resposta, /Posso criar o pedido/);
  assert.equal((await db().list('orders', t, (o) => o.contato === c)).length, 0, 'nada criado antes da confirmação');
  const r = await cliente('sim', c);
  assert.match(r.resposta, /criado/);
  const o = await primeiro((await db().list('orders', t, (x) => x.contato === c)));
  assert.equal(o.pagamento.status, 'pendente');
  const again = await cliente('me manda o link de novo', c);
  assert.match(again.resposta, new RegExp(o.pagamento.link.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.equal((await db().list('orders', t, (x) => x.contato === c)).length, 1, 'sem pedido duplicado');
  await call('POST', '/eventos', { type: 'payment.confirmed', data: { order_id: o.id } });
  assert.equal((await db().get('orders', o.id)).pagamento.status, 'confirmado');
});

test('Flora pausa quando um funcionário assume e não concede desconto', async () => {
  const c = '5511933332222';
  assert.match((await cliente('faz um desconto?', c)).resposta, /Não consigo oferecer desconto/);
  const conv = await primeiro((await db().list('conversations', t)).filter((x) => x.contato === c));
  await call('POST', `/atendimento/conversas/${encodeURIComponent(conv.id)}/assumir`, { texto: 'Oi, sou a Ana da loja' });
  assert.equal((await cliente('oi Ana', c)).resposta, null);
});

test('Mari: aprovação em lote e checagem de disponibilidade antes de publicar', async () => {
  await call('PUT', '/agentes/mari/config', { aprovacao: 'lote' });
  await call('POST', '/agentes/mari/executar');
  const pend = await call('GET', '/conteudo/posts?status=aguardando_aprovacao');
  assert.ok(pend.length >= 3);
  await call('POST', '/conteudo/aprovar', { ids: pend.slice(0, 2).map((p) => p.id) });
  const alvo = pend.find((p) => p.produto_ids.length === 1 && p.formato === 'feed');
  await call('POST', '/conteudo/aprovar', { ids: [alvo.id] });
  const prod = await getProduct(alvo.produto_ids[0]);
  await call('POST', '/loja/acao', { acao: 'ativar_produto', params: { produto: prod.nome, ativo: false } });
  assert.equal((await db().get('posts', alvo.id)).status, 'pausado_indisponivel');
});

test('Caio nunca passa do teto sem autorização e não escala com margem baixa', async () => {
  const { avaliar } = await import('../src/core/agents/caio.js');
  const t2 = await seedDemo(); await setHired(t2, 'flora', true); const tt = t; t = t2;
  const dec = (await avaliar(t2)).decisoes;
  assert.ok(dec.some((d) => d.acao === 'pedir_teto'), 'aumento que passaria o teto vira pedido de autorização');
  await call('POST', '/agentes/caio/executar');
  assert.ok((await call('GET', '/tarefas?responsavel=caio')).some((x) => /teto/i.test(x.titulo) && x.status === 'aguardando_dono'));
  const cesta = dec.find((d) => d.c.nome.includes('Cesta'));
  if (cesta) assert.equal(cesta.acao, 'manter');
  const ativo = (await db().list('campaigns', t2, (c) => c.status === 'ativa')).reduce((s, c) => s + c.orcamento_diario, 0);
  assert.ok(ativo <= 60);
  t = tt;
});

test('Contratação individual: agente não contratado não age', async () => {
  await setHired(t, 'sol', false);
  assert.match((await sol('Qual a margem da Cesta?')).texto, /não está contratada/);
  await setHired(t, 'sol', true);
});

test('Servidor: plataforma cria loja, chave de API autentica, painel abre por sessão', async () => {
  const r = await fetch(`${base}/api/v1/plataforma/lojas`, { method: 'POST', headers: { 'x-platform-key': 'plat', 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'Flores da Ana', iflores_store_id: 'x1', agentes: ['flora', 'caio'] }) });
  assert.equal(r.status, 201);
  const j = await r.json();
  const me = await (await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${j.api_key}` } })).json();
  assert.deepEqual(Object.entries(me.tenant.plano.agentes).filter(([, v]) => v).map(([k]) => k).sort(), ['caio', 'flora']);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: { authorization: 'Bearer ifa_errada' } })).status, 401);
  const s = await (await fetch(`${base}/api/v1/plataforma/lojas/x1/sessao`, { method: 'POST', headers: { 'x-platform-key': 'plat' } })).json();
  assert.equal((await fetch(`${base}/api/v1/equipe?token=${s.token}`)).status, 200);
  assert.ok(localDate());
});
