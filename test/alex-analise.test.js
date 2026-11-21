// Alex, gerente de IA: diagnóstico, recomendação com autorização, acompanhamento e isolamento entre lojas.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, db, comLoja } from '../src/core/store.js';
import { init } from '../src/core/index.js';
import { ativarContexto } from '../src/server/contexto.js';
import { seedDemo } from '../src/core/seed.js';
import { getSettings } from '../src/core/catalog.js';
import { addDays, localDate } from '../src/core/util.js';
import * as AN from '../src/core/agents/alex-analise.js';
import * as AL from '../src/core/agents/alex.js';

delete process.env.ANTHROPIC_API_KEY;
let A; let B;
const em = (t, fn) => comLoja(t, fn);
const hoje = localDate();

before(() => { ativarContexto(); init(createMemoryStore()); A = seedDemo('Loja A'); B = seedDemo('Loja B'); });

test('decomposição: visitas × taxa de compra × ticket somam exatamente a variação do faturamento', () => {
  em(A, () => {
    const fim = addDays(hoje, -1);
    const a = AN.janela(A, fim, 7); const b = AN.janela(A, addDays(fim, -7), 7);
    const d = AN.decomporVariacao(a, b);
    assert.ok(d, 'há dados nas duas semanas');
    const produto = (1 + d.partes.visitas.efeito) * (1 + d.partes.conversao.efeito) * (1 + d.partes.ticket.efeito);
    assert.ok(Math.abs(produto - a.faturamento / b.faturamento) < 1e-9, 'os três efeitos reconstroem a variação');
    assert.ok(['visitas', 'conversao', 'ticket'].includes(d.principal));
  });
});

test('formato: cada recomendação traz dado, fatos, interpretação, recomendação, autorização e acompanhamento', () => {
  em(A, () => {
    const recs = AN.gerarRecomendacoes(A, hoje);
    assert.ok(recs.length >= 2, 'a loja de demonstração tem sinais para analisar');
    for (const r of recs) {
      assert.ok(r.dado && r.interpretacao && r.recomendacao, r.titulo);
      assert.ok(Array.isArray(r.fatos) && Array.isArray(r.hipoteses), 'fatos e hipóteses separados');
      assert.ok('pergunta' in r.autorizacao || r.autorizacao.pergunta === null || typeof r.autorizacao.pergunta === 'string');
      assert.ok(r.acompanhamento.descricao.length > 0);
      assert.ok(['alta', 'media', 'baixa'].includes(r.confianca));
    }
    const texto = AN.formatarRecomendacao(recs[0], 1);
    for (const parte of ['1) Dado:', '2) O que pode significar:', '3) Recomendação:', '4)', '5) Acompanhamento:']) assert.ok(texto.includes(parte), parte);
  });
});

test('nada muda na loja só por analisar: a execução depende de autorização', () => {
  em(A, () => {
    const antes = JSON.stringify(getSettings(A).destaques_home);
    const produtosAntes = JSON.stringify(db().list('products', A).map((p) => [p.id, p.ativo, p.destaque]));
    AN.gerarRecomendacoes(A, hoje); AN.registrarRecomendacoes(A, hoje);
    assert.equal(JSON.stringify(getSettings(A).destaques_home), antes);
    assert.equal(JSON.stringify(db().list('products', A).map((p) => [p.id, p.ativo, p.destaque])), produtosAntes);
  });
});

test('aprovação executa, fixa a linha de base na execução e agenda revisão em 7 dias', () => {
  em(A, () => {
    const t = AN.registrarRecomendacoes(A, hoje).find((x) => x.recomendacao?.autorizacao?.acao?.acao === 'definir_destaques');
    assert.ok(t, 'há uma recomendação de destaque com ação autorizável');
    const alvo = t.recomendacao.autorizacao.acao.params.ids[0];
    AN.executarRecomendacao(A, t.id, hoje);
    const depois = db().get('tasks', t.id);
    assert.equal(getSettings(A).destaques_home[0], alvo, 'o produto ficou em primeiro na página inicial');
    assert.equal(depois.recomendacao.acompanhamento.revisar_em, addDays(hoje, 7));
    assert.ok(depois.recomendacao.acompanhamento.linha_base, 'linha de base registrada na execução');
    assert.match(depois.recomendacao.acompanhamento.linha_base.janela, /a /);
  });
});

test('acompanhamento compara duas janelas iguais e não afirma causa', () => {
  em(A, () => {
    const revisar = addDays(hoje, 7);
    AN.revisarRecomendacoes(A, revisar);
    const feitas = db().list('tasks', A, (x) => x.tipo === 'recomendacao' && x.revisada);
    assert.ok(feitas.length >= 1);
    for (const f of feitas) {
      assert.match(f.revisao.texto, /Antes .*Depois/);
      assert.match(f.revisao.texto, /não prova que a mudança causou/);
    }
  });
});

test('amostra pequena: a loja nova não recebe afirmações', () => {
  const C = `loja_vazia_${Date.now()}`;
  db().put('tenants', { id: C, tenant_id: C, name: 'Vazia', status: 'active', plano: { agentes: { alex: true } }, integrations: {} });
  em(C, () => {
    assert.deepEqual(AN.gerarRecomendacoes(C, hoje), []);
    assert.match(AN.comparacaoSemana(C, hoje).texto, /sem base|Faturamento/);
    assert.match(AL.conversar ? AN.diagnosticoQueda(C, hoje).texto : '', /dados suficientes/);
  });
});

test('perguntas do dono recebem respostas com números e sem promessa', async () => {
  await em(A, async () => {
    const queda = (await AL.conversar(A, 'Minhas vendas caíram. O que devo fazer?')).texto;
    assert.match(queda, /Faturamento: R\$/);
    const semana = (await AL.conversar(A, 'O que mudou em relação à semana passada?')).texto;
    assert.match(semana, /Últimos 7 dias/);
    const divulga = (await AL.conversar(A, 'Qual produto devo divulgar esta semana?')).texto;
    assert.match(divulga, /Produtos que valem divulgar|Nenhum produto/);
    const promo = (await AL.conversar(A, 'Vale a pena fazer uma promoção?')).texto;
    assert.match(promo, /Análise de promoção|Não tenho custos/);
    assert.doesNotMatch(promo, /vai aumentar|garanto|com certeza/i);
    const compra = (await AL.conversar(A, 'Quanto de rosa vermelha devo comprar?')).texto;
    assert.match(compra, /consumo previsto|Não encontrei/);
    assert.match(compra, /Estimativa|estimativa|não uma quantidade exata/);
  });
});

test('ações por comando claro: destaques são executados na hora, com histórico', async () => {
  await em(A, async () => {
    const r = await AL.conversar(A, 'Alex, coloque o Box Rosas & Ferrero em destaque na página inicial');
    assert.match(r.texto, /Coloquei .* em primeiro na página inicial/);
    assert.equal(getSettings(A).destaques_home[0], db().list('products', A, (p) => p.nome.startsWith('Box'))[0].id);
  });
});

test('isolamento: as recomendações de uma loja só apontam para produtos dela', () => {
  em(B, () => {
    const recs = AN.gerarRecomendacoes(B, hoje);
    for (const r of recs) if (r.acompanhamento.metrica?.produto_id) assert.ok(r.acompanhamento.metrica.produto_id.startsWith(`${B}:`), 'produto de outra loja');
    for (const r of recs) if (r.autorizacao.acao?.params?.ids) for (const id of r.autorizacao.acao.params.ids) assert.ok(id.startsWith(`${B}:`));
  });
});

test('"sim" depois de uma proposta executa a ação proposta; antes do "sim" nada muda', async () => {
  const L = seedDemo('Loja sim');
  await em(L, async () => {
    const antes = JSON.stringify(getSettings(L).destaques_home);
    const r = await AL.conversar(L, 'o que devo fazer?');
    assert.match(r.texto, /Se quiser, respondo "sim"/);
    assert.equal(JSON.stringify(getSettings(L).destaques_home), antes, 'a proposta não altera nada sozinha');
    const ok = await AL.conversar(L, 'sim');
    assert.match(ok.texto, /Coloquei na página inicial, nesta ordem/);
    assert.notEqual(JSON.stringify(getSettings(L).destaques_home), antes);
  });
});
