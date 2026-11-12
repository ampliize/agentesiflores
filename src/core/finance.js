// Motor financeiro da Sol. Funções puras sobre os dados da loja; toda resposta traz as premissas
// usadas e marca o cálculo como parcial quando falta informação.
//
// Definições:
//   CMV (custo da mercadoria)  = Σ insumos da ficha técnica × custo × (1 + perda%)  — ou custo informado
//   Custos variáveis           = % do preço (taxa de pagamento + impostos + comissão + outros)
//   Margem de contribuição     = preço − CMV − custos variáveis           (separada dos custos fixos)
//   Rateio dos custos fixos    = custos fixos mensais ÷ base (faturamento ou nº de pedidos esperado)
//   Resultado estimado         = margem de contribuição − rateio  (estimativa por produto; NÃO é o lucro líquido da loja)
import { db } from './store.js';
import { getConfig } from './team.js';
import { listProducts, insumoMap, getProduct } from './catalog.js';
import { brl, pct, round2, localDate, addDays } from './util.js';

export function params(tenantId) {
  const c = getConfig(tenantId, 'sol');
  const fixos = (c.custos_fixos || []).reduce((s, x) => s + (Number(x.valor) || 0), 0);
  const v = c.variaveis || {};
  const varPct = ((v.taxa_pagamento_pct || 0) + (v.impostos_pct || 0) + (v.comissao_pct || 0) + (v.outros_pct || 0)) / 100;
  return { cfg: c, fixos, varPct, rateio: c.rateio, margemAlvo: (c.margem_alvo_pct || 0) / 100 };
}

function premissasBase(P) {
  const out = [`Custos variáveis: ${pct(P.varPct)} do preço (taxa de pagamento ${P.cfg.variaveis.taxa_pagamento_pct}%, impostos ${P.cfg.variaveis.impostos_pct}%, comissão ${P.cfg.variaveis.comissao_pct}%, outros ${P.cfg.variaveis.outros_pct}%).`];
  if (P.fixos > 0) {
    out.push(P.rateio.base === 'volume'
      ? `Custos fixos de ${brl(P.fixos)}/mês rateados por ${P.rateio.pedidos_mensais_esperados} pedidos esperados = ${brl(P.fixos / P.rateio.pedidos_mensais_esperados)} por pedido.`
      : `Custos fixos de ${brl(P.fixos)}/mês rateados sobre ${brl(P.rateio.faturamento_mensal_esperado)} de faturamento esperado = ${pct(P.fixos / P.rateio.faturamento_mensal_esperado)} de cada venda.`);
  }
  return out;
}

export function cmvProduto(p, imap) {
  if (p.composicao?.length) {
    const itens = p.composicao.map((c) => {
      const i = imap[c.insumo_id];
      if (!i || i.custo == null) return { nome: i?.nome || c.insumo_id, qtd: c.qtd, faltando: true };
      const perda = (i.perda_pct || 0) / 100;
      return { nome: i.nome, qtd: c.qtd, unidade: i.unidade, custo_unit: i.custo, perda_pct: i.perda_pct || 0, total: round2(c.qtd * i.custo * (1 + perda)) };
    });
    const faltando = itens.filter((x) => x.faltando).map((x) => `custo do insumo "${x.nome}"`);
    return { valor: round2(itens.reduce((s, x) => s + (x.total || 0), 0)), fonte: 'ficha técnica', itens, faltando };
  }
  if (p.custo_informado != null) return { valor: p.custo_informado, fonte: 'custo informado pelo lojista', itens: [], faltando: [] };
  return { valor: null, fonte: null, itens: [], faltando: ['ficha técnica ou custo do produto'] };
}

/** Análise completa de um produto (ou de um preço hipotético). */
export function analisarProduto(tenantId, p, { preco, cmv: cmvOverride } = {}) {
  const P = params(tenantId);
  const c = cmvOverride != null ? { valor: cmvOverride, fonte: 'valor informado na conversa', itens: [], faltando: [] } : cmvProduto(p, insumoMap(tenantId));
  const pr = preco ?? p?.preco;
  const faltando = [...c.faltando];
  if (!P.fixos) faltando.push('custos fixos da loja');
  if (c.valor == null) return { produto: p?.nome, preco: pr, parcial: true, faltando, premissas: premissasBase(P) };
  const variaveis = pr * P.varPct;
  const mc = pr - c.valor - variaveis;
  const rateio = P.fixos ? (P.rateio.base === 'volume' ? P.fixos / P.rateio.pedidos_mensais_esperados : pr * (P.fixos / P.rateio.faturamento_mensal_esperado)) : 0;
  return {
    produto: p?.nome, produto_id: p?.id, preco: round2(pr),
    cmv: c.valor, cmv_fonte: c.fonte, cmv_itens: c.itens,
    variaveis: round2(variaveis), mc: round2(mc), mc_pct: pr ? mc / pr : 0,
    rateio: round2(rateio), resultado: round2(mc - rateio), resultado_pct: pr ? (mc - rateio) / pr : 0,
    parcial: faltando.length > 0, faltando, premissas: premissasBase(P),
  };
}

/** Preço mínimo, de equilíbrio e sugerido para um custo de produção. */
export function precoSugerido(tenantId, { custo, margemAlvoPct }) {
  const P = params(tenantId);
  const m = margemAlvoPct != null ? margemAlvoPct / 100 : P.margemAlvo;
  const premissas = [`Custo de produção (CMV) considerado: ${brl(custo)}.`, ...premissasBase(P), `Resultado desejado após o rateio: ${pct(m)} do preço.`];
  const faltando = P.fixos ? [] : ['custos fixos da loja'];
  let minimo; let equilibrio; let sugerido;
  if (P.rateio.base === 'volume') {
    const cfu = P.fixos / P.rateio.pedidos_mensais_esperados;
    minimo = custo / (1 - P.varPct); equilibrio = (custo + cfu) / (1 - P.varPct); sugerido = (custo + cfu) / (1 - P.varPct - m);
  } else {
    const cfp = P.fixos / P.rateio.faturamento_mensal_esperado;
    minimo = custo / (1 - P.varPct); equilibrio = custo / (1 - P.varPct - cfp);
    const den = 1 - P.varPct - cfp - m;
    sugerido = den > 0 ? custo / den : null;
  }
  const arred = (v) => (v == null ? null : Math.ceil(v) - 0.1);
  const res = { custo, minimo: round2(minimo), equilibrio: round2(equilibrio), sugerido: sugerido && round2(sugerido), sugerido_arredondado: arred(sugerido), premissas, faltando, parcial: faltando.length > 0 };
  if (sugerido) res.analise = analisarProduto(tenantId, null, { preco: res.sugerido_arredondado, cmv: custo });
  return res;
}

/** Efeito de um desconto sobre a margem e quanto a mais seria preciso vender para compensar. */
export function impactoDesconto(tenantId, { produto, preco, cmv, descontoPct }) {
  const p = produto || null;
  const antes = analisarProduto(tenantId, p, { preco: preco ?? p?.preco, cmv });
  if (antes.cmv == null) return { parcial: true, faltando: antes.faltando, premissas: antes.premissas };
  const novoPreco = antes.preco * (1 - descontoPct / 100);
  const depois = analisarProduto(tenantId, p, { preco: novoPreco, cmv: antes.cmv });
  const extra = depois.mc > 0 ? antes.mc / depois.mc - 1 : null;
  return { produto: antes.produto, desconto_pct: descontoPct, antes, depois, vendas_extra_necessarias: extra, inviavel: depois.mc <= 0, premissas: antes.premissas, parcial: antes.parcial, faltando: antes.faltando };
}

export function margens(tenantId) {
  return listProducts(tenantId).filter((p) => (p.tipo || 'produto') === 'produto').map((p) => analisarProduto(tenantId, p));
}

/** Resumo do período a partir das vendas registradas (dias + pedidos). */
export function resumoPeriodo(tenantId, { dias = 30, fim = localDate() } = {}) {
  const ini = addDays(fim, -dias + 1);
  const rows = db().list('dias', tenantId, (d) => d.data >= ini && d.data <= fim);
  const an = Object.fromEntries(margens(tenantId).map((a) => [a.produto_id, a]));
  let fat = 0; let mc = 0; let descontos = 0; let pedidos = 0; let semCusto = 0;
  const porProduto = {};
  for (const r of rows) {
    fat += r.faturamento; pedidos += r.pedidos; descontos += r.descontos || 0;
    for (const [pid, q] of Object.entries(r.vendas || {})) {
      porProduto[pid] = (porProduto[pid] || 0) + q;
      const a = an[pid];
      if (a?.mc != null) mc += a.mc * q; else semCusto += q;
    }
  }
  mc -= descontos * (1 - params(tenantId).varPct);
  const P = params(tenantId);
  const fixosPeriodo = P.fixos * (dias / 30);
  return { inicio: ini, fim, dias, faturamento: round2(fat), pedidos, ticket: pedidos ? round2(fat / pedidos) : 0, descontos: round2(descontos), mc: round2(mc), mc_pct: fat ? mc / fat : 0, custos_fixos: round2(fixosPeriodo), resultado: round2(mc - fixosPeriodo), por_produto: porProduto, itens_sem_custo: semCusto };
}

/** "Por que estou vendendo mais e sobrando menos?" — compara dois períodos e aponta as causas. */
export function diagnosticoMargem(tenantId, dias = 30) {
  const atual = resumoPeriodo(tenantId, { dias });
  const anterior = resumoPeriodo(tenantId, { dias, fim: addDays(atual.inicio, -1) });
  const an = Object.fromEntries(margens(tenantId).map((a) => [a.produto_id, a]));
  const causas = [];
  const dMc = atual.mc_pct - anterior.mc_pct;
  // efeito do mix: produtos de margem baixa ganhando participação
  const mix = Object.keys({ ...atual.por_produto, ...anterior.por_produto }).map((pid) => {
    const qa = atual.por_produto[pid] || 0; const qb = anterior.por_produto[pid] || 0; const a = an[pid];
    return { pid, nome: a?.produto || pid, mc_pct: a?.mc_pct, delta: qa - qb, qa, qb };
  }).filter((x) => x.mc_pct != null);
  const baixa = mix.filter((x) => x.mc_pct < 0.35 && x.delta > 0).sort((a, b) => b.delta - a.delta);
  if (baixa.length) causas.push(`Cresceram as vendas de produtos com margem baixa: ${baixa.slice(0, 3).map((x) => `${x.nome} (${pct(x.mc_pct)} de margem, ${x.qb}→${x.qa} un.)`).join('; ')}.`);
  if (atual.descontos > anterior.descontos * 1.2 && atual.descontos > 0) causas.push(`Os descontos subiram de ${brl(anterior.descontos)} para ${brl(atual.descontos)} e saem direto da margem.`);
  if (dMc < -0.01) causas.push(`A margem de contribuição média caiu de ${pct(anterior.mc_pct)} para ${pct(atual.mc_pct)} do faturamento.`);
  if (atual.itens_sem_custo) causas.push(`${atual.itens_sem_custo} itens vendidos não têm custo cadastrado; o cálculo é parcial.`);
  if (!causas.length) causas.push('Não encontrei queda de margem relevante nos dados disponíveis.');
  return { atual, anterior, causas };
}

export const analisarPorId = (tenantId, id) => analisarProduto(tenantId, getProduct(id));
