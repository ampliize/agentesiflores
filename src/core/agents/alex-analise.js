// ALEX — análise de negócio. Transforma números em orientação prática, no formato:
//   1) dado  2) interpretação  3) recomendação  4) autorização  5) acompanhamento
// Regras de honestidade:
//   • cada recomendação separa FATOS (medidos) de HIPÓTESES (não confirmadas);
//   • só afirma taxas e tendências com amostra mínima; abaixo disso diz a limitação;
//   • nunca promete que uma mudança vai aumentar as vendas;
//   • a execução só acontece com autorização (comando claro do dono ou aprovação da recomendação);
//   • o acompanhamento mede a mesma janela de 7 dias antes e depois, e avisa que isso não prova causa.
import { db } from '../store.js';
import { listProducts, getProduct, getSettings, disponibilidade, acharProduto } from '../catalog.js';
import { analisarProduto, impactoDesconto, params as finParams } from '../finance.js';
import { IFloresClient } from '../integrations/iflores.js';
import { getTenant } from '../team.js';
import { createTask, listTasks, updateTask, getTask } from '../tasks.js';
import { executar } from './alex-actions.js';
import { log } from '../events.js';
import { addDays, localDate, brl, pct, round2, now, fmtDia } from '../util.js';

export const AMOSTRA_MINIMA_VISITAS = 200;   // visitas em 7 dias para afirmar taxas da loja
export const AMOSTRA_MINIMA_PRODUTO = 40;    // visualizações de um produto em 7 dias para afirmar a taxa dele
const sg = (v) => `${v >= 0 ? '+' : ''}${pct(v)}`;

// ---------------------------------------------------------------- janelas e métricas
/** Soma os indicadores de `dias` terminando em `fim`. */
export async function janela(tenantId, fim, dias = 7) {
  const ini = addDays(fim, -dias + 1);
  const rows = await db().list('dias', tenantId, (d) => d.data >= ini && d.data <= fim);
  const w = { ini, fim, dias: rows.length, visitas: 0, carrinhos: 0, checkouts: 0, pedidos: 0, faturamento: 0,
    pagina: { home: 0, categoria: 0, produto: 0 }, vendas: {}, buscas: {} };
  for (const r of rows) {
    w.visitas += r.visitas || 0; w.carrinhos += r.carrinhos || 0; w.checkouts += r.checkouts || 0;
    w.pedidos += r.pedidos || 0; w.faturamento += r.faturamento || 0;
    for (const k of Object.keys(w.pagina)) w.pagina[k] += r.visitas_pagina?.[k] || 0;
    for (const [k, v] of Object.entries(r.vendas || {})) w.vendas[k] = (w.vendas[k] || 0) + v;
    for (const [k, v] of Object.entries(r.buscas || {})) w.buscas[k] = (w.buscas[k] || 0) + v;
  }
  w.faturamento = round2(w.faturamento);
  w.conversao = w.visitas ? w.pedidos / w.visitas : 0;
  w.ticket = w.pedidos ? w.faturamento / w.pedidos : 0; // sem arredondar: a identidade V×C×T precisa fechar
  w.share_home = w.visitas ? w.pagina.home / w.visitas : 0;
  w.conversao_produtos = sum(Object.values(w.buscas)) ? sum(Object.values(w.vendas)) / sum(Object.values(w.buscas)) : 0;
  return w;
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/**
 * Decompõe a variação do faturamento em visitas × taxa de compra × ticket.
 * Identidade exata: faturamento = visitas × (pedidos/visitas) × (faturamento/pedidos).
 * Usa logaritmos, então as três partes somam exatamente a variação total.
 */
export function decomporVariacao(atual, anterior) {
  if (!atual.faturamento || !anterior.faturamento || !atual.visitas || !anterior.visitas || !atual.pedidos || !anterior.pedidos) return null;
  const total = Math.log(atual.faturamento / anterior.faturamento);
  const logs = {
    visitas: Math.log(atual.visitas / anterior.visitas),
    conversao: Math.log(atual.conversao / anterior.conversao),
    ticket: Math.log(atual.ticket / anterior.ticket),
  };
  const partes = {};
  for (const [k, p] of Object.entries(logs)) partes[k] = { efeito: Math.exp(p) - 1, peso: Math.abs(total) < 1e-9 ? 0 : p / total };
  const principal = Object.entries(logs).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0];
  const check = Object.values(logs).reduce((s, x) => s + x, 0) - total;
  if (Math.abs(check) > 1e-9) return null; // nunca derruba a rotina; sem decomposição, não se afirma causa
  return { variacao: atual.faturamento / anterior.faturamento - 1, partes, principal };
}

/** Etapas do funil: visita→carrinho, carrinho→pagamento iniciado, pagamento iniciado→pedido. */
function etapas(w) {
  return {
    carrinho: w.visitas ? w.carrinhos / w.visitas : 0,
    pagamento: w.carrinhos ? w.checkouts / w.carrinhos : 0,
    pedido: w.checkouts ? w.pedidos / w.checkouts : 0,
  };
}
const ROTULO_ETAPA = { carrinho: 'de quem visita, poucos colocam produto no carrinho', pagamento: 'de quem põe no carrinho, poucos iniciam o pagamento', pedido: 'de quem inicia o pagamento, poucos concluem' };
const ROTULO_PRINCIPAL = { visitas: 'menos pessoas chegando à loja', conversao: 'mais visitantes saindo sem comprar', ticket: 'clientes comprando menos por pedido' };

// ---------------------------------------------------------------- montagem das recomendações
function montar(o) {
  return {
    id: o.id, titulo: o.titulo, tipo: o.tipo, prioridade: o.prioridade,
    dado: o.dado, fatos: o.fatos || [], hipoteses: o.hipoteses || [],
    interpretacao: o.interpretacao, recomendacao: o.recomendacao,
    confianca: o.confianca || 'media', limitacoes: o.limitacoes || [],
    autorizacao: { pergunta: o.pergunta || null, acao: o.acao || null },
    acompanhamento: { metrica: o.metrica, janela_dias: 7, revisar_em: null, linha_base: null,
      descricao: o.acompanhamentoTexto || `Vou comparar ${o.metricaRotulo} nos 7 dias antes da mudança com os 7 dias depois.` },
  };
}

async function recQueda(tenantId, fim, lojaConv) {
  const a = await janela(tenantId, fim, 7); const b = await janela(tenantId, addDays(fim, -7), 7);
  const d = decomporVariacao(a, b);
  if (!d || d.variacao > -0.1) return [];
  const confianca = a.visitas >= AMOSTRA_MINIMA_VISITAS && b.visitas >= AMOSTRA_MINIMA_VISITAS ? 'alta' : 'baixa';
  const p = d.principal; const fatos = [
    `Visitas: ${sg(d.partes.visitas.efeito)} (${a.visitas} contra ${b.visitas}).`,
    `Taxa de compra: ${sg(d.partes.conversao.efeito)} (${pct(a.conversao)} contra ${pct(b.conversao)}).`,
    `Ticket médio: ${sg(d.partes.ticket.efeito)} (${brl(a.ticket)} contra ${brl(b.ticket)}).`,
  ];
  const limitacoes = [];
  if (confianca === 'baixa') limitacoes.push(`Poucas visitas na amostra (${a.visitas} e ${b.visitas}); a leitura é provisória.`);
  const base = { id: `queda:${p}`, tipo: 'queda', prioridade: 1, confianca, fatos, limitacoes, metricaRotulo: 'o faturamento' };
  const dado = `Faturamento de ${brl(a.faturamento)} nos últimos 7 dias, ${sg(d.variacao)} em relação aos 7 anteriores (${brl(b.faturamento)}).`;
  if (p === 'visitas') {
    const top = await topVendidos(tenantId, a, 3);
    return [montar({ ...base, titulo: 'Queda de faturamento causada por menos visitas', dado,
      interpretacao: `O maior efeito veio de ${ROTULO_PRINCIPAL.visitas}. Isso costuma ser falta de divulgação ou de procura, mas os dados desta loja não dizem de onde vêm os visitantes.`,
      hipoteses: ['A divulgação diminuiu ou os anúncios perderam alcance.', 'A procura caiu na época.'],
      recomendacao: 'Pôr os produtos que mais vendem no início da página inicial, onde ainda chega a maior parte dos visitantes, e acompanhar se as visitas voltam.',
      pergunta: top.length ? `Quer que eu coloque ${top.map((x) => x.nome).join(', ')} nessa ordem nos destaques da página inicial?` : null,
      acao: top.length ? { acao: 'definir_destaques', params: { ids: top.map((x) => x.id) } } : null,
      metrica: { nome: 'faturamento' }, limitacoes: [...limitacoes, 'Não tenho a origem dos visitantes (anúncio, busca ou redes); a hipótese de divulgação não está confirmada.'] })];
  }
  if (p === 'conversao') {
    const ea = etapas(a); const eb = etapas(b);
    const piora = Object.keys(ea).map((k) => ({ k, mudanca: eb[k] ? ea[k] / eb[k] - 1 : 0 })).sort((x, y) => x.mudanca - y.mudanca)[0];
    return [montar({ ...base, titulo: 'Visitantes estão saindo sem comprar', dado,
      interpretacao: `O maior efeito veio de ${ROTULO_PRINCIPAL.conversao}. A etapa que mais piorou foi a de ${piora.k === 'carrinho' ? 'colocar no carrinho' : piora.k === 'pagamento' ? 'iniciar o pagamento' : 'concluir o pedido'}: ${ROTULO_ETAPA[piora.k]}.`,
      hipoteses: { carrinho: ['Preço, foto ou descrição pouco convincentes para quem chega.'], pagamento: ['Frete ou prazo de entrega pouco claros no fim da compra.'], pedido: ['Pagamento falhando ou cliente desistindo ao ver o total com frete.'] }[piora.k],
      recomendacao: 'Verificar primeiro a etapa que piorou (frete, prazo, pagamento na iFlores e disponibilidade dos produtos mais vistos). Não é uma ação que eu consiga executar sozinho.',
      pergunta: null, acao: null, metrica: { nome: 'faturamento' }, limitacoes })];
  }
  // ticket
  return [montar({ ...base, titulo: 'Clientes comprando menos por pedido', dado,
    interpretacao: `O maior efeito veio de ${ROTULO_PRINCIPAL.ticket}. Visitas e taxa de compra se mantiveram.`,
    hipoteses: ['Menos complementos sendo vendidos.', 'Mix de produtos mais baratos vendido nesta semana.'],
    recomendacao: 'Oferecer complementos (cartão, chocolate, pelúcia) no fechamento da compra e destacar arranjos de maior valor. Essas ações dependem do atendimento e da equipe.',
    pergunta: null, acao: null, metrica: { nome: 'faturamento' }, limitacoes })];
}

async function topVendidos(tenantId, w, n) {
  const s = await getSettings(tenantId);
  const ps = (await listProducts(tenantId)).filter((p) => (p.tipo || 'produto') === 'produto' && disponibilidade(p, s).ok);
  return ps.map((p) => ({ id: p.id, nome: p.nome, vendas: w.vendas[p.id] || 0 })).filter((x) => x.vendas > 0).sort((a, b) => b.vendas - a.vendas).slice(0, n);
}

async function recIndisponivel(tenantId, w, lojaConv) {
  const s = await getSettings(tenantId); const out = [];
  for (const p of (await listProducts(tenantId)).filter((x) => (x.tipo || 'produto') === 'produto')) {
    const disp = disponibilidade(p, s); if (disp.ok) continue;
    const views = w.buscas[p.id] || 0; if (views < 15) continue;
    const perdido = round2(views * lojaConv * p.preco);
    out.push(montar({ id: `indisp:${p.id}`, tipo: 'indisponivel', prioridade: 2, titulo: `${p.nome} está indisponível e ainda recebe visitas`,
      dado: `${views} visualizações nos últimos 7 dias, com o produto ${disp.motivo}.`,
      fatos: [`Motivo: ${disp.motivo}.`, `Vendas no período: ${w.vendas[p.id] || 0}.`],
      hipoteses: [`Se o produto estivesse disponível, a loja venderia perto de ${brl(perdido)} a mais, usando a taxa média da loja.`],
      interpretacao: 'Clientes chegam até o produto e não conseguem comprar. Isso é venda perdida, não falta de interesse.',
      recomendacao: 'Repor o estoque se houver como comprar. Se não houver, tirar o produto da divulgação e de anúncios até voltar.',
      pergunta: 'Quantas unidades chegaram? Com o número eu atualizo o estoque.',
      acao: null, confianca: 'media', metrica: { nome: 'vendas_produto', produto_id: p.id }, metricaRotulo: `as vendas de ${p.nome}`,
      limitacoes: ['A estimativa de venda perdida usa a taxa média da loja e é só uma referência.'] }));
  }
  return out.slice(0, 2);
}

async function recDestaque(tenantId, w, lojaConv) {
  const s = await getSettings(tenantId); const atuais = s.destaques_home || [];
  const top = (await topVendidos(tenantId, w, 1))[0]; if (!top || top.vendas < 3) return [];
  const p = await getProduct(top.id); const taxa = (w.buscas[p.id] || 0) ? top.vendas / w.buscas[p.id] : null;
  if (taxa !== null && taxa < lojaConv) return [];
  if (atuais[0] === top.id) return [];
  const totalVendas = sum(Object.values(w.vendas)) || 1;
  const nomes = [];
  for (const id of atuais) { const q = await getProduct(id); if (q) nomes.push(q.nome); }
  return [montar({ id: `destaque:${p.id}`, tipo: 'destaque', prioridade: 3, titulo: `Colocar ${p.nome} em primeiro nos destaques`,
    dado: `${top.vendas} vendas nos últimos 7 dias, ${pct(top.vendas / totalVendas, 0)} do total da loja.`,
    fatos: [`Página inicial: ${pct(w.share_home, 0)} das visitas passaram por ela.`, nomes.length ? `Destaques atuais: ${nomes.join(', ')}.` : 'Ainda não há produtos definidos para a página inicial.', taxa !== null ? `Taxa de compra do produto: ${pct(taxa)} (média da loja: ${pct(lojaConv)}).` : 'Visualizações do produto não foram medidas.'],
    hipoteses: ['Com mais destaque, mais visitantes encontram este produto.'],
    interpretacao: 'Um produto que vende bem e não aparece no começo da página deixa dinheiro na mesa, principalmente porque a maioria das visitas começa pela página inicial.',
    recomendacao: `Colocar ${p.nome} em primeiro e manter os outros destaques atrás, e acompanhar se as vendas dele sobem.`,
    pergunta: `Quer que eu coloque ${p.nome} em primeiro nos destaques da página inicial?`,
    acao: { acao: 'definir_destaques', params: { ids: [p.id, ...atuais.filter((id) => id !== p.id)].slice(0, 6) } },
    confianca: w.visitas >= AMOSTRA_MINIMA_VISITAS ? 'alta' : 'baixa', metrica: { nome: 'vendas_produto', produto_id: p.id }, metricaRotulo: `as vendas de ${p.nome}`,
    limitacoes: w.visitas < AMOSTRA_MINIMA_VISITAS ? ['Poucas visitas na semana para afirmar o efeito dos destaques.'] : [] })];
}

async function recVisitasSemVenda(tenantId, w, lojaConv) {
  const s = await getSettings(tenantId); const out = [];
  for (const p of (await listProducts(tenantId)).filter((x) => (x.tipo || 'produto') === 'produto')) {
    if (!disponibilidade(p, s).ok) continue;
    const views = w.buscas[p.id] || 0; if (views < AMOSTRA_MINIMA_PRODUTO) continue;
    const taxa = (w.vendas[p.id] || 0) / views;
    if (taxa > lojaConv * 0.5) continue;
    out.push(montar({ id: `semvenda:${p.id}`, tipo: 'visitas_sem_venda', prioridade: 4, titulo: `${p.nome} recebe visitas e quase não vende`,
      dado: `${views} visualizações e ${w.vendas[p.id] || 0} venda(s) nos últimos 7 dias (${pct(taxa)} de compra; média da loja ${pct(lojaConv)}).`,
      fatos: [`Preço: ${brl(p.preco)}.`, `Descrição cadastrada: ${p.descricao ? 'sim' : 'não'}.`],
      hipoteses: ['Preço alto para o que a foto mostra.', 'Foto pouco atrativa.', 'Descrição não responde dúvidas comuns.'],
      interpretacao: 'Muita gente olha e não compra. O problema está na oferta do produto, não na procura.',
      recomendacao: 'Revisar foto, descrição e preço antes de qualquer campanha. Testar uma mudança de cada vez.',
      pergunta: null, acao: null, confianca: 'media', metrica: { nome: 'conversao_produto', produto_id: p.id }, metricaRotulo: `a taxa de compra de ${p.nome}`, limitacoes: [] }));
  }
  return out.slice(0, 2);
}

async function recCampanha(tenantId, w) {
  const s = await getSettings(tenantId);
  const avaliados = [];
  for (const p of (await listProducts(tenantId)).filter((p) => (p.tipo || 'produto') === 'produto' && disponibilidade(p, s).ok)) avaliados.push({ p, a: await analisarProduto(tenantId, p) });
  const cands = avaliados.filter((x) => x.a.mc_pct != null && x.a.mc_pct >= 0.45 && (w.vendas[x.p.id] || 0) >= 2).sort((x, y) => y.a.mc - x.a.mc)[0];
  if (!cands) return [];
  const { p, a } = cands;
  return [montar({ id: `campanha:${p.id}`, tipo: 'campanha', prioridade: 5, titulo: `${p.nome} pode entrar em campanha`,
    dado: `Margem de contribuição de ${pct(a.mc_pct)} (${brl(a.mc)} por unidade) e ${w.vendas[p.id] || 0} venda(s) nos últimos 7 dias, com produto disponível.`,
    fatos: [`Resultado estimado após rateio: ${brl(a.resultado)} por unidade (estimativa).`],
    hipoteses: ['Um anúncio para este produto pode trazer compras com margem boa. Isso ainda não foi testado nesta loja.'],
    interpretacao: 'Produto com margem boa e disponível aguenta o custo de um anúncio melhor do que produtos de margem apertada.',
    recomendacao: 'Pedir ao Caio uma proposta de campanha, com teto de gasto definido por você. Nada é publicado sem a sua aprovação.',
    pergunta: `Quer que eu peça ao Caio uma proposta de campanha para ${p.nome}?`,
    acao: { acao: 'pedir_campanha', params: { produto_id: p.id } }, confianca: 'media',
    metrica: { nome: 'vendas_produto', produto_id: p.id }, metricaRotulo: `as vendas de ${p.nome}`,
    limitacoes: ['A margem usa as fichas de custo cadastradas; sem elas o cálculo é parcial.'] })];
}

async function recReposicao(tenantId, hoje) {
  // importado de alex.js (função de cálculo de compras); feito por injeção para evitar ciclo
  const c = await comprasDe(tenantId, hoje); const linhas = c.linhas.filter((l) => l.sugerido > 0).slice(0, 3);
  if (!linhas.length) return [];
  return [montar({ id: 'reposicao', tipo: 'reposicao', prioridade: 6, titulo: 'Flores e insumos que precisam de reposição',
    dado: `Previsão de consumo para ${c.periodo.dias} dias com base nas vendas: ${linhas.map((l) => `${l.insumo} (~${l.sugerido} ${l.unidade})`).join(', ')}.`,
    fatos: [`Consumo calculado a partir das vendas de ${c.periodo.dias} dias e da ficha de composição.`],
    hipoteses: ['O consumo previsto segue o ritmo das últimas duas semanas.'],
    interpretacao: 'Estimativa de consumo, não quantidade exata de compra. Ela depende do estoque real e do que o fornecedor tem.',
    recomendacao: 'Confirmar o estoque físico antes de comprar e, se for uma data forte, ajustar a quantidade pela data.',
    pergunta: null, acao: null, confianca: c.limitacoes.length ? 'baixa' : 'media',
    metrica: null, metricaRotulo: 'o estoque', acompanhamentoTexto: 'Não há medição automática para compra de flores. Confirme o estoque depois da compra, na aba Loja.', limitacoes: ['Esta é uma estimativa.', ...c.limitacoes] })];
}

// injeção feita pelo alex.js (sugestaoCompras mora lá)
let comprasDe = () => ({ linhas: [], limitacoes: [], periodo: { dias: 0 } });
export function registrarCompras(fn) { comprasDe = fn; }

/** Todas as recomendações atuais da loja, por prioridade. Não grava nada. */
export async function gerarRecomendacoes(tenantId, hoje = localDate()) {
  const fim = addDays(hoje, -1);
  const w = await janela(tenantId, fim, 7);
  const lojaConv = w.conversao_produtos;
  const recs = [
    ...(await recQueda(tenantId, fim, lojaConv)),
    ...(await recIndisponivel(tenantId, w, lojaConv)),
    ...(await recDestaque(tenantId, w, lojaConv)),
    ...(await recVisitasSemVenda(tenantId, w, lojaConv)),
    ...(await recCampanha(tenantId, w)),
    ...(await recReposicao(tenantId, hoje)),
  ];
  return recs.sort((a, b) => a.prioridade - b.prioridade).slice(0, 6);
}

/** Grava as recomendações como tarefas (sem duplicar; atualiza os números das abertas). */
export async function registrarRecomendacoes(tenantId, hoje = localDate()) {
  const saida = [];
  for (const r of await gerarRecomendacoes(tenantId, hoje)) {
    const aberta = (await listTasks(tenantId, { tipo: 'recomendacao' })).find((t) => t.titulo === r.titulo && ['aguardando_dono', 'aberta'].includes(t.status));
    if (aberta) { saida.push(await updateTask(aberta.id, { recomendacao: { ...r, acompanhamento: aberta.recomendacao?.acompanhamento || r.acompanhamento } })); continue; }
    saida.push(await createTask(tenantId, { responsavel: 'alex', solicitante: 'alex', tipo: 'recomendacao', titulo: r.titulo, detalhes: r.recomendacao, acao: r.autorizacao.acao, extra: { recomendacao: r } }));
  }
  return saida;
}

// ---------------------------------------------------------------- execução e acompanhamento
/** Valor da métrica de acompanhamento numa janela de 7 dias terminando em `fim`. */
export async function medir(tenantId, metrica, fim) {
  const w = await janela(tenantId, fim, 7);
  if (metrica.nome === 'faturamento') return w.faturamento;
  if (metrica.nome === 'vendas_produto') return w.vendas[metrica.produto_id] || 0;
  if (metrica.nome === 'conversao_produto') { const v = w.buscas[metrica.produto_id] || 0; return v ? (w.vendas[metrica.produto_id] || 0) / v : 0; }
  return null;
}

/** Executa a ação autorizada (ou marca como feita) e fixa a linha de base do acompanhamento. */
export async function executarRecomendacao(tenantId, taskId, hoje = localDate()) {
  const t = await getTask(taskId);
  if (!t || t.tenant_id !== tenantId) throw new Error('Recomendação não encontrada');
  const rec = t.recomendacao; const fim = addDays(hoje, -1);
  let r;
  if (!rec?.autorizacao?.acao) {
    r = { texto: 'Marcada como feita. Vou acompanhar o resultado.' };
  } else if (rec.autorizacao.acao.acao === 'pedir_campanha') {
    const p = await getProduct(rec.autorizacao.acao.params.produto_id);
    await createTask(tenantId, { responsavel: 'caio', solicitante: 'alex', tipo: 'pedido', titulo: `Propor campanha para ${p?.nome || 'produto'}`, detalhes: 'Pedido do Alex com base em margem e vendas. Respeitar o teto de gasto.' });
    r = { executado: true, texto: `Pedi ao Caio uma proposta de campanha para ${p?.nome}. Ela aparece em Tarefas para sua aprovação.` };
  } else {
    r = await executar(tenantId, rec.autorizacao.acao.acao, rec.autorizacao.acao.params, { comando: t.titulo, confirmado: true });
  }
  const revisar = addDays(hoje, 7);
  const acomp = { ...rec.acompanhamento, revisar_em: revisar, linha_base: { valor: await medir(tenantId, rec.acompanhamento.metrica, fim), janela: `${addDays(fim, -6)} a ${fim}` } };
  await updateTask(taskId, { status: 'concluida', resultado: r.texto, executada_em: now(), change_id: r.change_id, recomendacao: { ...rec, acompanhamento: acomp } }, 'dono');
  log(tenantId, 'alex', `Acompanhamento iniciado: ${rec.titulo}. Revisão em ${fmtDia(revisar)}.`, { type: 'acompanhamento' });
  return r;
}

/** Compara a janela antes (fixada na execução) com a janela depois, de mesmo tamanho. */
export async function revisarRecomendacoes(tenantId, hoje = localDate()) {
  const devidas = (await listTasks(tenantId, { tipo: 'recomendacao', status: 'concluida' }))
    .filter((t) => !t.revisada && t.recomendacao?.acompanhamento?.revisar_em && t.recomendacao.acompanhamento.revisar_em <= hoje);
  for (const t of devidas) {
    const acomp = t.recomendacao.acompanhamento; const metrica = acomp.metrica;
    if (!metrica?.nome) { await updateTask(t.id, { revisada: true, revisao: { em: now(), texto: 'Esta recomendação não tem medição automática. Confirme o resultado na aba Loja.' } }); continue; }
    const antes = acomp.linha_base?.valor; const depois = await medir(tenantId, metrica, addDays(acomp.revisar_em, -1));
    let veredito = 'ficou parecido';
    if (antes > 0 && depois != null) { const d = depois / antes - 1; if (d >= 0.1) veredito = `subiu ${sg(d)}`; else if (d <= -0.1) veredito = `caiu ${sg(d)}`; }
    else if (antes === 0 && depois > 0) veredito = 'saiu do zero';
    const texto = `Antes (${acomp.linha_base?.janela}): ${fmt(antes)}. Depois (7 dias até ${fmtDia(addDays(acomp.revisar_em, -1))}): ${fmt(depois)}. Resultado: ${veredito}. Isso compara duas semanas; não prova que a mudança causou a diferença, porque sazonalidade, anúncios e clima também mudam as vendas.`;
    await updateTask(t.id, { revisada: true, revisao: { em: now(), texto, antes, depois } });
    log(tenantId, 'alex', `Revisão de "${t.titulo}": ${veredito}`, { type: 'revisao' });
  }
  return devidas.length;
}
const fmt = (v) => (v == null ? 'sem dado' : typeof v === 'number' && v < 1.5 && v > 0 && !Number.isInteger(v) ? pct(v) : String(v));

// ---------------------------------------------------------------- formatação para o dono
/** Texto com as cinco partes do formato de recomendação. */
export function formatarRecomendacao(r, n = '') {
  const fatos = r.fatos.map((x) => `      • ${x}`).join('\n');
  const hip = r.hipoteses.length ? `\n      Hipóteses (não confirmadas): ${r.hipoteses.join(' ')}` : '';
  const lim = r.limitacoes.length ? `\n   Limitações: ${r.limitacoes.join(' ')}` : '';
  return `${n ? `${n}. ` : ''}${r.titulo}  [confiança ${r.confianca}]
   1) Dado: ${r.dado}
${fatos}${hip}
   2) O que pode significar: ${r.interpretacao}
   3) Recomendação: ${r.recomendacao}
   4) ${r.autorizacao.pergunta || 'Não há ação automática: depende de você.'}
   5) Acompanhamento: ${r.acompanhamento.descricao}${lim}`;
}

// ---------------------------------------------------------------- perguntas diretas
export async function diagnosticoQueda(tenantId, hoje = localDate()) {
  const fim = addDays(hoje, -1); const a = await janela(tenantId, fim, 7); const b = await janela(tenantId, addDays(fim, -7), 7);
  const d = decomporVariacao(a, b);
  if (!d) return { texto: 'Ainda não tenho dados suficientes das duas semanas para comparar. Preciso de visitas e pedidos dos 14 últimos dias.', recomendacoes: [] };
  const recs = (await gerarRecomendacoes(tenantId, hoje)).filter((r) => ['queda', 'indisponivel', 'visitas_sem_venda', 'destaque'].includes(r.tipo));
  const linhas = [
    `Faturamento: ${brl(a.faturamento)} nos últimos 7 dias, ${sg(d.variacao)} em relação às 7 anteriores.`,
    `Pelas partes: visitas ${sg(d.partes.visitas.efeito)}, taxa de compra ${sg(d.partes.conversao.efeito)}, ticket ${sg(d.partes.ticket.efeito)}. O maior peso foi ${ROTULO_PRINCIPAL[d.principal]}.`,
  ];
  if (a.visitas < AMOSTRA_MINIMA_VISITAS) linhas.push(`Atenção: só ${a.visitas} visitas na semana. Com pouca amostra, a leitura é provisória.`);
  return { texto: `${linhas.join('\n')}\n\n${recs.length ? recs.map((r, i) => formatarRecomendacao(r, i + 1)).join('\n\n') : 'Não encontrei causa clara nos dados disponíveis.'}`, recomendacoes: recs };
}

export async function comparacaoSemana(tenantId, hoje = localDate()) {
  const fim = addDays(hoje, -1); const a = await janela(tenantId, fim, 7); const b = await janela(tenantId, addDays(fim, -7), 7);
  const d = decomporVariacao(a, b);
  const linhas = [
    `Últimos 7 dias contra os 7 anteriores (${fmtDia(b.ini)}–${fmtDia(b.fim)}):`,
    `• Faturamento: ${brl(a.faturamento)} contra ${brl(b.faturamento)} (${d ? sg(d.variacao) : 'sem base de comparação'})`,
    `• Visitas: ${a.visitas} contra ${b.visitas}${d ? ` (${sg(d.partes.visitas.efeito)})` : ''}`,
    `• Taxa de compra: ${pct(a.conversao)} contra ${pct(b.conversao)}${d ? ` (${sg(d.partes.conversao.efeito)})` : ''}`,
    `• Ticket médio: ${brl(a.ticket)} contra ${brl(b.ticket)}${d ? ` (${sg(d.partes.ticket.efeito)})` : ''}`,
    `• Página inicial: ${pct(a.share_home, 0)} das visitas, contra ${pct(b.share_home, 0)} na semana anterior`,
  ];
  if (d) linhas.push(`\nO que mais mudou: ${ROTULO_PRINCIPAL[d.principal]}.`);
  return { texto: linhas.join('\n') };
}

export async function sugestoesDivulgacao(tenantId, hoje = localDate()) {
  const fim = addDays(hoje, -1); const w = await janela(tenantId, fim, 7); const lojaConv = w.conversao_produtos;
  const s = await getSettings(tenantId);
  const candidatos = [];
  for (const p of (await listProducts(tenantId)).filter((p) => (p.tipo || 'produto') === 'produto' && disponibilidade(p, s).ok && (w.buscas[p.id] || 0) >= AMOSTRA_MINIMA_PRODUTO)) {
    candidatos.push({ p, views: w.buscas[p.id], vendas: w.vendas[p.id] || 0, taxa: (w.vendas[p.id] || 0) / w.buscas[p.id], a: await analisarProduto(tenantId, p) });
  }
  const cands = candidatos
    .filter((x) => x.taxa >= lojaConv && (x.a.mc_pct == null || x.a.mc_pct >= 0.35))
    .sort((x, y) => y.taxa - x.taxa).slice(0, 3);
  if (!cands.length) return { texto: 'Nenhum produto reúne os três critérios ao mesmo tempo: procura suficiente, boa taxa de compra e margem aceitável. Vale revisar preço e foto antes de divulgar.', pendente: null };
  const linhas = cands.map((x) => `• ${x.p.nome}: ${x.views} visualizações, ${x.vendas} venda(s) (${pct(x.taxa)} de compra, média da loja ${pct(lojaConv)})${x.a.mc_pct != null ? `, margem ${pct(x.a.mc_pct, 0)}` : ', margem sem custo cadastrado'}.`);
  return {
    texto: `Produtos que valem divulgar esta semana, com base na procura, na compra e na margem:\n${linhas.join('\n')}\n\nFatos: são os números acima. Hipótese: anúncio e post sobre esses produtos podem trazer compras, mas isso ainda não foi testado nesta loja.`,
    pendente: { acao: 'pedir_campanha', params: { produto_id: cands[0].p.id } },
    pergunta: `Quer que eu peça ao Caio uma proposta de campanha para ${cands[0].p.nome}?`,
  };
}

export async function analisePromocao(tenantId, produtoTexto, descontoPct = 10, hoje = localDate()) {
  const w = await janela(tenantId, addDays(hoje, -1), 7);
  const s = await getSettings(tenantId); const cap = s.capacidade_pedidos_dia;
  const ocupacao = w.dias ? (w.pedidos / w.dias) / cap : 0;
  const ps = produtoTexto ? await acharProduto(tenantId, produtoTexto) : [];
  let alvos;
  if (ps.length === 1) alvos = [ps[0]];
  else {
    const cand = [];
    for (const p of (await listProducts(tenantId)).filter((p) => (p.tipo || 'produto') === 'produto' && disponibilidade(p, s).ok)) {
      cand.push({ p, taxa: (w.buscas[p.id] || 0) ? (w.vendas[p.id] || 0) / w.buscas[p.id] : null, mc: (await analisarProduto(tenantId, p)).mc_pct });
    }
    alvos = cand.filter((x) => x.mc != null && x.mc >= 0.4).sort((x, y) => (x.taxa ?? 0) - (y.taxa ?? 0)).slice(0, 3).map((x) => x.p);
  }
  if (!alvos.length) return { texto: 'Não tenho custos cadastrados suficientes para avaliar uma promoção com segurança. Cadastre as fichas de custo na Sol primeiro.' };
  const linhas = [];
  for (const p of alvos) {
    const d = await impactoDesconto(tenantId, { produto: p, descontoPct });
    if (d.parcial && d.antes?.cmv == null) linhas.push(`• ${p.nome}: sem custo cadastrado, não consigo calcular.`);
    else if (d.inviavel) linhas.push(`• ${p.nome}: com ${descontoPct}% a margem fica negativa. Não recomendo.`);
    else linhas.push(`• ${p.nome}: com ${descontoPct}% de desconto, a margem cai de ${brl(d.antes.mc)} para ${brl(d.depois.mc)} por unidade. Para ganhar o mesmo dinheiro, seria preciso vender ${pct(d.vendas_extra_necessarias, 0)} a mais.`);
  }
  const capa = ocupacao > 0.85 ? `\nA produção já está em ${pct(ocupacao, 0)} da capacidade diária. Uma promoção pode gerar mais pedidos do que a loja consegue entregar.` : `\nA produção está em ${pct(ocupacao, 0)} da capacidade diária, então há folga para mais pedidos.`;
  return {
    texto: `Análise de promoção (${descontoPct}% de desconto):\n${linhas.join('\n')}${capa}\n\nFato: os números acima usam as fichas de custo e o rateio da Sol. Hipótese: a promoção só compensa se trouxer volume novo, o que ainda não foi testado. Não prometo resultado.`,
  };
}

export function comprasItem(tenantId, termo, c) {
  const alvo = (c?.linhas || []).filter((l) => l.insumo && termo && norm(l.insumo).includes(norm(termo)));
  if (!alvo.length) return { texto: `Não encontrei "${termo}" na lista de insumos com consumo previsto. Confira o nome do insumo na aba Loja.` };
  const l = alvo[0];
  return { texto: `${l.insumo}: consumo previsto de ${l.consumo} ${l.unidade} em ${c.periodo.dias} dias (com ${l.perda_pct}% de perda). Estoque informado: ${l.estoque} ${l.unidade}. Sugestão de compra: ~${l.sugerido} ${l.unidade}.\nFato: consumo calculado pelas vendas e pela ficha de composição. Hipótese: o ritmo das últimas duas semanas se mantém.\nLimitação: ${l.estoque_informado ? 'confirme o estoque físico antes de comprar.' : 'o estoque não foi informado; considerei zero.'} Isto é uma estimativa, não uma quantidade exata.` };
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Atualiza as vendas por página e por produto a partir da iFlores (analytics). */
export async function importarAnalytics(tenantId, hoje = localDate()) {
  const cli = new IFloresClient(await getTenant(tenantId));
  if (!cli.conectado) return { importados: 0 };
  const r = await cli.analytics(addDays(hoje, -14), addDays(hoje, -1));
  let n = 0;
  for (const d of r?.dias || []) {
    const id = `${tenantId}:${d.data}`; const atual = (await db().get('dias', id)) || { id, tenant_id: tenantId, data: d.data, visitas: 0, carrinhos: 0, checkouts: 0, pedidos: 0, faturamento: 0, vendas: {}, buscas: {}, descontos: 0 };
    await db().put('dias', { ...atual, visitas: d.visitas ?? atual.visitas, carrinhos: d.carrinhos ?? atual.carrinhos, checkouts: d.checkouts ?? atual.checkouts, visitas_pagina: d.visitas_pagina ?? atual.visitas_pagina, buscas: d.buscas ?? atual.buscas });
    n++;
  }
  return { importados: n };
}
