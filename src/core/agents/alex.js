// ALEX — gerente da floricultura: executa alterações por conversa e orienta o negócio com dados.
// Toda recomendação responde: o que aconteceu, hipótese, o que fazer agora, o que o Alex pode
// executar e quando revisar o resultado.
import { registrarCompras, diagnosticoQueda, comparacaoSemana, sugestoesDivulgacao, analisePromocao, comprasItem, formatarRecomendacao, gerarRecomendacoes, registrarRecomendacoes, revisarRecomendacoes } from './alex-analise.js';
import { db, serial } from '../store.js';
import { getConfig, active, AGENTS } from '../team.js';
import { log, working } from '../events.js';
import { createTask, listTasks, updateTask, getTask } from '../tasks.js';
import { listProducts, getSettings, listInsumos, getProduct, disponibilidade, listChanges, comemorativoAtivo } from '../catalog.js';
import { periodo, compararSemanas, funil, listOrders, topPerguntas } from '../orders.js';
import { analisarProduto, impactoDesconto } from '../finance.js';
import { proximasDatas } from '../calendar.js';
import { ACTIONS, executar } from './alex-actions.js';
import { aiEnabled, runToolLoop } from '../llm.js';
import { brl, pct, norm, localDate, addDays, fmtDia, parseDia, parseValor, uid, now, round2 } from '../util.js';

const variacao = (a, b) => (b ? (a - b) / b : 0);
const sinal = (v) => `${v >= 0 ? '+' : ''}${pct(v)}`;

// ======================= INDICADORES E RELATÓRIOS =======================
export async function resumoDiario(tenantId, hoje = localDate()) {
  const ontem = addDays(hoje, -1);
  const d = await periodo(tenantId, ontem, ontem);
  const mesmoDiaSemanaPassada = await periodo(tenantId, addDays(ontem, -7), addDays(ontem, -7));
  const pedidosHoje = await listOrders(tenantId, (o) => o.data === hoje && o.status !== 'cancelado');
  const amanha = await listOrders(tenantId, (o) => o.data === addDays(hoje, 1) && o.status !== 'cancelado');
  const aguardando = await listOrders(tenantId, (o) => o.status === 'aguardando_pagamento');
  const prioridades = (await listTasks(tenantId)).filter((t) => ['aguardando_dono', 'aberta'].includes(t.status)).slice(0, 5).map((t) => `${AGENTS[t.responsavel]?.nome || t.responsavel}: ${t.titulo}`);
  const alteracoes = (await listChanges(tenantId)).filter((c) => c.created_at.slice(0, 10) === hoje);
  return {
    data: hoje,
    ontem: { ...d, comparacao: { faturamento: variacao(d.faturamento, mesmoDiaSemanaPassada.faturamento), pedidos: variacao(d.pedidos, mesmoDiaSemanaPassada.pedidos) } },
    producao: { hoje: pedidosHoje.length, amanha: amanha.length, aguardando_pagamento: aguardando.length },
    perguntas: (await topPerguntas(tenantId, 3)).map((q) => `${q.tema} (${q.total})`),
    alteracoes: alteracoes.map((c) => c.descricao),
    prioridades,
    texto: [
      `Resumo de ${fmtDia(hoje)}`,
      `Ontem: ${d.pedidos} pedidos, ${brl(d.faturamento)} (${sinal(variacao(d.faturamento, mesmoDiaSemanaPassada.faturamento))} vs. mesmo dia da semana passada).`,
      `Produção: ${pedidosHoje.length} pedido(s) para hoje e ${amanha.length} para amanhã. ${aguardando.length} aguardando pagamento.`,
      prioridades.length ? `Prioridades:\n${prioridades.map((p) => `• ${p}`).join('\n')}` : 'Sem pendências abertas.',
    ].join('\n'),
  };
}

export async function relatorioSemanal(tenantId, hoje = localDate()) {
  const { atual, anterior } = await compararSemanas(tenantId, hoje);
  const prods = Object.fromEntries((await listProducts(tenantId)).map((p) => [p.id, p]));
  const top = Object.entries(atual.vendas).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, q]) => ({ nome: prods[id]?.nome || id, qtd: q }));
  const procurados = Object.entries(atual.buscas).map(([id, b]) => ({ id, nome: prods[id]?.nome || id, buscas: b, vendas: atual.vendas[id] || 0 }))
    .map((x) => ({ ...x, conv: x.buscas ? x.vendas / x.buscas : 0 })).sort((a, b) => b.buscas - a.buscas).slice(0, 6);
  const f = funil(atual); const fa = funil(anterior);
  return {
    atual, anterior,
    variacoes: { faturamento: variacao(atual.faturamento, anterior.faturamento), pedidos: variacao(atual.pedidos, anterior.pedidos), visitas: variacao(atual.visitas, anterior.visitas), conversao: variacao(atual.conversao, anterior.conversao), ticket: variacao(atual.ticket, anterior.ticket) },
    funil: f.map((e, i) => ({ ...e, taxa_anterior: fa[i].taxa })),
    top, procurados,
  };
}

// ======================= COMPRAS DE FLORES E INSUMOS =======================
export async function sugestaoCompras(tenantId, hoje = localDate()) {
  const cfg = (await getConfig(tenantId, 'alex')).compras;
  const base = await periodo(tenantId, addDays(hoje, -14), addDays(hoje, -1));
  const diasBase = Math.max(1, base.dias);
  const s = await getSettings(tenantId);
  const janelaFim = addDays(hoje, cfg.dias_cobertura - 1);
  const data = proximasDatas(cfg.dias_cobertura + 2, hoje).find((d) => d.peso >= 4);
  const comemorativo = (s.modo_comemorativo || []).some((m) => m.inicio <= janelaFim && m.fim >= hoje);
  const fator = data || comemorativo ? cfg.fator_data_comemorativa : 1;
  const prods = await listProducts(tenantId);
  const consumo = {}; const semComposicao = [];
  for (const p of prods) {
    const vendidos = base.vendas[p.id] || 0;
    if (!vendidos) continue;
    const previsto = (vendidos / diasBase) * cfg.dias_cobertura * fator;
    if (!p.composicao?.length) { semComposicao.push(p.nome); continue; }
    for (const c of p.composicao) consumo[c.insumo_id] = (consumo[c.insumo_id] || 0) + previsto * c.qtd;
  }
  const linhas = (await listInsumos(tenantId)).filter((i) => consumo[i.id]).map((i) => {
    const perda = (i.perda_pct ?? cfg.perda_padrao_pct) / 100;
    const necessario = consumo[i.id] * (1 + perda);
    const estoque = i.estoque ?? 0; const previstas = i.compra_prevista || 0;
    const sugerido = Math.max(0, Math.ceil((necessario - estoque - previstas) / (i.multiplo || 1)) * (i.multiplo || 1));
    return { insumo: i.nome, unidade: i.unidade, tipo: i.tipo, consumo: Math.round(consumo[i.id]), perda_pct: Math.round(perda * 100), estoque, compras_previstas: previstas, sugerido, custo_estimado: round2(sugerido * (i.custo || 0)), estoque_informado: i.estoque != null };
  }).sort((a, b) => b.sugerido - a.sugerido);
  const limitacoes = [];
  if (semComposicao.length) limitacoes.push(`${semComposicao.length} produto(s) vendido(s) sem composição cadastrada ficaram fora do cálculo: ${semComposicao.join(', ')}.`);
  if (linhas.some((l) => !l.estoque_informado)) limitacoes.push('Alguns insumos não têm estoque informado; considerei estoque zero.');
  if (base.dias < 14) limitacoes.push(`Só há ${base.dias} dia(s) de histórico de vendas.`);
  return {
    periodo: { de: hoje, ate: janelaFim, dias: cfg.dias_cobertura }, base_dias: base.dias, fator,
    motivo_fator: data ? `${data.nome} em ${data.faltam} dia(s)` : comemorativo ? 'catálogo comemorativo ativo' : null,
    linhas, limitacoes, custo_total: round2(linhas.reduce((s2, l) => s2 + l.custo_estimado, 0)),
    aviso: 'É uma estimativa de consumo a partir das vendas e da composição dos produtos, não uma quantidade exata de compra. Ajuste com a sua experiência e com o fornecedor.',
  };
}

// ======================= RECOMENDAÇÕES =======================
// ======================= RECOMENDAÇÕES E ANÁLISE (alex-analise.js) =======================
export { gerarRecomendacoes, registrarRecomendacoes, executarRecomendacao, revisarRecomendacoes, janela, decomporVariacao, importarAnalytics } from './alex-analise.js';
registrarCompras(sugestaoCompras);

// ======================= CONVERSA COM O DONO =======================
export async function getChat(tenantId, agente = 'alex') {
  return (await db().get('chats', `${tenantId}:${agente}`)) || { id: `${tenantId}:${agente}`, tenant_id: tenantId, agente, mensagens: [], pendente: null };
}
export async function saveChat(chat) { return db().put('chats', chat); }

function interpretar(tenantId, texto, pendente) {
  const t = norm(texto);
  if (pendente) {
    if (/^(sim|pode|confirmo|confirma|ok|isso|claro|pode sim|bloqueia|bloquear tambem|tambem)\b/.test(t)) return { acao: pendente.acao, params: pendente.params, confirmado: true };
    if (/^(nao|cancela|deixa|nao precisa)\b/.test(t)) return { texto: 'Combinado, não alterei mais nada.' };
    if (pendente.falta === 'produto') return { acao: pendente.acao, params: { ...pendente.params, produto: texto.trim() } };
    if (pendente.falta === 'bairro') return { acao: pendente.acao, params: { ...pendente.params, bairro: texto.trim().replace(/^(o |a |bairro |no |na )+/i, '').replace(/[.!]$/, '') } };
  }
  if (/\b(desfaz|desfaca|desfazer|reverte|reverter|volta o que)\b/.test(t)) return { acao: 'desfazer' };
  let m;
  if (/comemorativ/.test(t)) {
    if (/(desativ|deslig|encerr|tira)/.test(t)) return { acao: 'data_comemorativa', params: { ativo: false } };
    m = t.match(/(?:do |de )?dia (\d{1,2}(?:\/\d{1,2})?) (?:ao|a|ate o|ate) (?:dia )?(\d{1,2}(?:\/\d{1,2})?)/) || t.match(/de (\d{1,2}\/\d{1,2}) a (\d{1,2}\/\d{1,2})/);
    if (m) { const ini = parseDia(m[1].includes('/') ? m[1] : `dia ${m[1]}`); let fim = parseDia(m[2].includes('/') ? m[2] : `dia ${m[2]}`); if (fim < ini) fim = parseDia(`${m[2]}/${ini.slice(5, 7)}`); return { acao: 'data_comemorativa', params: { inicio: ini, fim, ativo: true } }; }
    return { acao: 'data_comemorativa', params: { ativo: true } };
  }
  if ((m = t.match(/(?:acabou|acabaram|faltou|faltaram|nao temos mais|nao tem mais|estamos sem|ficamos sem)\s+(?:a |o |as |os )?([a-z ]+?)(?:[.,;!]|\s+(?:desativ|tir|pode|por favor)|$)/))) return { acao: 'desativar_por_item', params: { item: m[1].trim() } };
  if ((m = t.match(/desativ\w*\s+(?:todos )?(?:os )?produtos\s+(?:que usam|que tem|que levam|com|de)\s+(?:a |o |as |os )?([a-z ]+?)(?:[.,;!]|$)/))) return { acao: 'desativar_por_item', params: { item: m[1].trim() } };
  if ((m = t.match(/(?:chegou|chegaram|voltou|voltaram|repusemos|temos de novo)\s+(?:a |o |as |os )?([a-z ]+?)(?:[.,;!]|\s+(?:reativ|ativ|pode)|$)/))) return { acao: 'reativar_por_item', params: { item: m[1].trim() } };
  if (/estoque/.test(t)) {
    const q = t.match(/para (\d+)/) || t.match(/(\d+) (?:unidades|un|itens)/);
    const p = t.match(/estoque (?:do |da |de |dos |das )?(?:produto )?(.+?)(?: para \d+| com \d+|$)/);
    let produto = p?.[1]?.trim() || '';
    if (/^(deste|desse|este|esse)( produto)?$/.test(produto)) produto = 'deste produto';
    return { acao: 'atualizar_estoque', params: { produto, quantidade: q ? Number(q[1]) : null } };
  }
  if (/frete/.test(t)) {
    const valor = parseValor(t.replace(/.*?(?:para|=|em|por)\s+(r\$\s*)?(?=\d)/, ''));
    const b = t.match(/frete (?:do |da |de |para o |para a |no |na |pro |pra )?(?:bairro )?(.+?) (?:para|em|=|por|a) (?:r\$\s*)?\d/);
    let bairro = b?.[1]?.trim() || '';
    if (/^(desse|deste|esse|este)( bairro)?$/.test(bairro)) bairro = 'desse bairro';
    return { acao: 'configurar_frete', params: { bairro: bairro === 'desse bairro' ? bairro : texto.match(new RegExp(bairro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0] || bairro, valor } };
  }
  const dia = parseDia(t);
  if (/(nao (?:teremos|vamos ter|tera|vai ter|havera|faremos)|sem) entregas?/.test(t)) return { acao: 'bloquear_data', params: { data: dia, entrega: true, retirada: /retirada/.test(t), pedidos: false } };
  if (/(nao (?:teremos|vamos ter|tera|vai ter|havera)|sem) retiradas?/.test(t)) return { acao: 'bloquear_data', params: { data: dia, entrega: false, retirada: true, pedidos: false } };
  if (/(nao vamos abrir|nao abriremos|loja fechada|vamos fechar|estaremos fechados|fechado no dia|fechados no dia)/.test(t) && dia) return { acao: 'bloquear_data', params: { data: dia, pedidos: true } };
  if (/(libera|desbloque)\w*/.test(t) && dia) return { acao: 'liberar_data', params: { data: dia } };
  if ((m = t.match(/das? (\d{1,2})(?:h|:(\d{2}))?\s*(?:h)?\s*(?:as|a|ate)\s*(\d{1,2})(?:h|:(\d{2}))?/)) && dia) {
    const hh = (h, mm) => `${String(h).padStart(2, '0')}:${mm || '00'}`;
    return { acao: 'horario_especial', params: { data: dia, abre: hh(m[1], m[2]), fecha: hh(m[3], m[4]) } };
  }
  if (/(paus|pare|parar|suspend|para)\w* (de )?(receber )?(novos )?pedidos/.test(t)) return { acao: 'receber_pedidos', params: { ativo: false } };
  if (/(volt|retom|reabr)\w* (a )?(receber )?pedidos/.test(t)) return { acao: 'receber_pedidos', params: { ativo: true } };
  if (/(destaq|pagina inicial|em primeiro)/.test(t) && !/(qual|quais|vale a pena)/.test(t)) {
    const tira = /(tir|remov|retir|sai)/.test(t);
    const m = t.match(/(?:coloque|coloca|ponha|poe|bota|destaque|destaca|tire|tira|remova|retire)\s+(?:o |a |os |as )?(.+?)(?:\s+(?:em destaque|nos destaques|no destaque|na pagina inicial|em primeiro|dos destaques|da pagina inicial|da home)|$)/);
    if (m && m[1] && !/^(?:do|da|dos|das|um|uma)$/.test(m[1])) return { acao: 'destacar_na_home', params: { produto: m[1].trim(), destaque: !tira } };
  }
  if (/(destaq|destac)/.test(t) && !/(qual|quais|vale a pena)/.test(t)) {
    const destaque = !/(tir|remov|sai)/.test(t);
    const p = t.replace(/.*(?:destaque|destaques|destacar|destaca|destaque o|destaque a)\s+(?:o |a |os |as |do |da |dos )?/, '').replace(/\s*(?:dos|nos) destaques.*/, '').replace(/^(tire|tira|remova)\s+(o |a )?/, '');
    return { acao: 'destacar_produto', params: { produto: p, destaque } };
  }
  if ((m = t.match(/^(?:alex,?\s*)?(ative|ativa|ativar|reative|reativa|desative|desativa|desativar)\s+(?:o |a )?(?:produto )?(.+?)[.!]?$/))) return { acao: 'ativar_produto', params: { produto: m[2], ativo: !/^des/.test(m[1]) } };
  if (/quanto .*(comprar|compro|compra)/.test(t)) { const item = t.replace(/.*quanto (?:de |do |da |dos |das )?/, '').replace(/ ?(devo|preciso|vou|tenho que)? ?(comprar|compro|compra).*/, '').trim(); if (item && item.length > 2) return { info: 'compras_item', item }; }
  if (/(caiu|cairam|caiam|diminu|queda|vendendo menos|menos venda)/.test(t)) return { info: 'queda' };
  if (/(o que mudou|semana passada|em relacao a semana|comparad[ao] com)/.test(t)) return { info: 'comparacao' };
  if (/(promocao|promocoes|desconto)/.test(t) && /(vale|faz sentido|devo|posso|compensa|compens)/.test(t)) return { info: 'promocao' };
  if (/(divulg|destaqu|destacar|promover)/.test(t) && /(qual|quais|devo|esta semana|vale)/.test(t)) return { info: 'divulgacao' };
  if (/(compra|comprar|fornecedor|insumo|quantas (?:hastes|flores))/.test(t)) return { info: 'compras' };
  if (/(semana|semanal|relatorio)/.test(t)) return { info: 'semanal' };
  if (/(recomend|o que (?:devo|eu devo|fazer)|prioridad|cair|caiu|cairam|queda|caindo|por que .*vend)/.test(t)) return { info: 'recomendacoes' };
  if (/(resumo|como (?:foi|esta|estamos)|hoje|ontem|bom dia)/.test(t)) return { info: 'resumo' };
  return { ajuda: true };
}

function formatarSemanal(r) {
  const v = r.variacoes;
  return [`Semana ${fmtDia(r.atual.ini)}–${fmtDia(r.atual.fim)} vs. ${fmtDia(r.anterior.ini)}–${fmtDia(r.anterior.fim)}:`,
    `• Faturamento ${brl(r.atual.faturamento)} (${sinal(v.faturamento)})`, `• Pedidos ${r.atual.pedidos} (${sinal(v.pedidos)}) · ticket ${brl(r.atual.ticket)} (${sinal(v.ticket)})`,
    `• Visitas ${r.atual.visitas} (${sinal(v.visitas)}) · conversão ${pct(r.atual.conversao)} (${sinal(v.conversao)})`,
    `Mais vendidos: ${r.top.map((x) => `${x.nome} (${x.qtd})`).join(', ')}.`,
    `Procurados x vendidos: ${r.procurados.slice(0, 4).map((x) => `${x.nome} ${x.buscas}/${x.vendas}`).join(', ')}.`].join('\n');
}
function formatarRecs(recs) {
  if (!recs.length) return 'Não encontrei nada fora do normal nos dados desta semana. Quando houver algo, eu trago com os números.';
  return recs.map((r, i) => formatarRecomendacao(r, i + 1)).join('\n\n');
}
function formatarCompras(c) {
  return [`Estimativa de consumo de ${fmtDia(c.periodo.de)} a ${fmtDia(c.periodo.ate)}${c.motivo_fator ? ` (×${c.fator} por ${c.motivo_fator})` : ''}:`,
    ...c.linhas.filter((l) => l.sugerido > 0).slice(0, 10).map((l) => `• ${l.insumo}: comprar ~${l.sugerido} ${l.unidade} (consumo ${l.consumo} + perda ${l.perda_pct}% − estoque ${l.estoque})`),
    `Custo estimado: ${brl(c.custo_total)}.`, ...c.limitacoes.map((x) => `Limitação: ${x}`), c.aviso].join('\n');
}
const AJUDA = 'Posso executar na loja, por exemplo:\n• "Acabou a rosa vermelha. Desative os produtos que usam essa flor."\n• "No dia 7 não teremos entregas."\n• "Ative o catálogo de data comemorativa do dia 10 ao dia 12."\n• "Atualize o estoque do Buquê Encanto para 15 unidades."\n• "Configure o frete da Vila Mariana para R$12."\n• "Dia 24 vamos abrir das 8h às 13h."\n• "Desfaça a última alteração."\nE também: "resumo do dia", "relatório da semana", "o que devo fazer?", "sugestão de compras".';

async function responderInfo(tenantId, info, it = {}) {
  if (info === 'resumo') return (await resumoDiario(tenantId)).texto;
  if (info === 'semanal') return formatarSemanal(await relatorioSemanal(tenantId));
  if (info === 'compras') return formatarCompras(await sugestaoCompras(tenantId));
  if (info === 'compras_item') return comprasItem(tenantId, it.item, await sugestaoCompras(tenantId)).texto;
  if (info === 'queda') { const d = await diagnosticoQueda(tenantId); const c = d.recomendacoes.find((r) => r.autorizacao.acao); return { texto: d.texto, pendente: c ? c.autorizacao.acao : null }; }
  if (info === 'comparacao') return (await comparacaoSemana(tenantId)).texto;
  if (info === 'promocao') return (await analisePromocao(tenantId, null)).texto;
  if (info === 'divulgacao') { const d = await sugestoesDivulgacao(tenantId); return { texto: d.texto + (d.pergunta ? `\n\n${d.pergunta}` : ''), pendente: d.pendente }; }
  if (info === 'recomendacoes') {
    const recs = await gerarRecomendacoes(tenantId); await registrarRecomendacoes(tenantId);
    const c = recs.find((r) => r.autorizacao.acao);
    return { texto: formatarRecs(recs) + (c ? `\n\nSe quiser, respondo "sim" e executo a primeira proposta com ação: ${c.titulo}.` : ''), pendente: c ? c.autorizacao.acao : null };
  }
  return AJUDA;
}

const LLM_SYSTEM = async (tenantId, cfg) => `Você é o Alex, gerente da floricultura dentro do iFlores. Fale português do Brasil, direto e cordial.
Você executa alterações na loja usando as ferramentas e orienta o dono com base nos dados.
Regras:
- Use apenas as ferramentas para alterar a loja; nunca diga que fez algo que nenhuma ferramenta confirmou.
- Se faltar um dado ou houver ambiguidade (ex.: "deste produto", "desse bairro"), faça UMA pergunta curta antes de executar.
- Depois de uma alteração em lote, explique o que encontrou e o que executou, e lembre que produtos sem a informação no cadastro podem ter ficado de fora.
- Recomendações seguem SEMPRE as cinco partes: 1) dado (números e período), 2) o que pode significar, 3) recomendação e por quê, 4) pergunta se o dono autoriza a execução, 5) como vai acompanhar o resultado.
- Separe fatos de hipóteses. Diga "hipótese" quando não estiver medido. Nunca prometa que uma mudança aumenta as vendas.
- Só afirme que um produto é o mais vendido ou que tem boa taxa de compra com os números da ferramenta. Se a amostra for pequena, diga.
- Uma ação que o dono pediu com comando claro se executa. Uma ação que você mesmo recomendou só se executa depois de o dono aprovar.
- Antes de recomendar descontos ou promoções, consulte a análise financeira (ferramenta consultar_sol).
- Estimativas de compra não são quantidades exatas.
Hoje é ${localDate()}. Permissões: ${JSON.stringify(cfg.permissoes)}. ${cfg.instrucoes || ''}`;

function llmTools(tenantId, comando) {
  const typeOf = (t) => (t.includes('[]') ? ['array', 'null'] : t.startsWith('number') ? ['number', 'null'] : t.startsWith('boolean') ? ['boolean', 'null'] : ['string', 'null']);
  const tools = Object.entries(ACTIONS).map(([name, a]) => {
    const props = Object.fromEntries(Object.entries({ ...a.params, ...(name === 'desativar_por_item' ? { confirmado: 'boolean' } : {}) }).map(([k, t]) => [k, { type: typeOf(t), ...(t.includes('[]') ? { items: { type: 'string' } } : {}), ...(t.startsWith('date') ? { description: 'YYYY-MM-DD' } : {}) }]));
    return { name, description: a.descricao, input_schema: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
      run: (input) => { const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v != null)); return executar(tenantId, name, clean, { comando, confirmado: !!input.confirmado }); } };
  });
  const info = (name, description, fn) => ({ name, description, input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} }, run: fn });
  tools.push(info('resumo_do_dia', 'Indicadores de ontem, produção de hoje e pendências.', () => resumoDiario(tenantId)));
  tools.push(info('relatorio_semanal', 'Comparação da semana com a anterior, funil, mais vendidos e procurados x vendidos.', () => relatorioSemanal(tenantId)));
  tools.push(info('sugestao_compras', 'Estimativa de compra de flores e insumos.', () => sugestaoCompras(tenantId)));
  tools.push(info('recomendacoes', 'Recomendações com hipótese, ação e data de revisão (registradas em Tarefas).', async () => { await registrarRecomendacoes(tenantId); return gerarRecomendacoes(tenantId); }));
  const tool = (name, description, props, required, run) => ({ name, description, input_schema: { type: 'object', additionalProperties: false, required, properties: props }, run });
  tools.push(info('diagnostico_queda', 'Diagnóstico de queda de vendas: decompõe a variação em visitas, taxa de compra e ticket, e traz as recomendações.', () => diagnosticoQueda(tenantId).then((r) => r.texto)));
  tools.push(info('comparar_semanas', 'Comparação dos últimos 7 dias com os 7 anteriores, com o que mais mudou.', () => comparacaoSemana(tenantId).then((r) => r.texto)));
  tools.push(info('sugestoes_divulgacao', 'Produtos que valem divulgar agora, com procura, taxa de compra e margem.', () => sugestoesDivulgacao(tenantId).then((r) => r.texto)));
  tools.push(tool('analise_promocao', 'Efeito de uma promoção sobre a margem e sobre a capacidade. Sem produto, analisa os candidatos.', { produto: { type: ['string', 'null'] }, desconto_pct: { type: ['number', 'null'] } }, [], (i) => analisePromocao(tenantId, i.produto || null, i.desconto_pct || 10).then((r) => r.texto)));
  tools.push(tool('compras_item', 'Quanto comprar de uma flor ou insumo, com consumo previsto, perda, estoque e limitações.', { item: { type: 'string' } }, ['item'], (i) => sugestaoCompras(tenantId).then((c) => comprasItem(tenantId, i.item, c).texto)));
  tools.push({ name: 'consultar_sol', description: 'Pergunta à Sol o impacto de um desconto em um produto.', input_schema: { type: 'object', additionalProperties: false, required: ['produto', 'desconto_pct'], properties: { produto: { type: 'string' }, desconto_pct: { type: 'number' } } },
    run: async ({ produto, desconto_pct }) => { const p = (await listProducts(tenantId)).find((x) => norm(x.nome).includes(norm(produto))); return p ? impactoDesconto(tenantId, { produto: p, descontoPct: desconto_pct }) : { erro: 'produto não encontrado' }; } });
  return tools;
}

export function conversar(tenantId, texto, opts = {}) { return serial(`${tenantId}:chat:alex`, () => conversarAgora(tenantId, texto, opts)); }
async function conversarAgora(tenantId, texto, opts = {}) {
  if (!(await active(tenantId, 'alex'))) return { texto: 'O Alex não está contratado ou está pausado nesta loja.' };
  const chat = await getChat(tenantId);
  chat.mensagens.push({ role: 'user', texto, em: now() });
  const resposta = await working(tenantId, 'alex', 'Atendendo um pedido do dono', async () => {
    if (aiEnabled()) {
      const history = chat.mensagens.slice(-16).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.texto }));
      const r = await runToolLoop({ system: await LLM_SYSTEM(tenantId, await getConfig(tenantId, 'alex')), messages: history, tools: llmTools(tenantId, texto), effort: 'medium', trace: opts.trace });
      return { texto: r.text || 'Não consegui concluir. Pode reformular?' };
    }
    const it = interpretar(tenantId, texto, chat.pendente);
    chat.pendente = null;
    if (it.texto) return { texto: it.texto };
    if (it.info) { const x = await responderInfo(tenantId, it.info, it); if (typeof x === 'string') return { texto: x }; if (x.pendente) chat.pendente = x.pendente; return { texto: x.texto }; }
    if (it.ajuda) return { texto: AJUDA };
    const r = await executar(tenantId, it.acao, it.params, { comando: texto, confirmado: it.confirmado });
    if (r.negado) return { texto: r.negado };
    if (r.pergunta) { chat.pendente = r.pendente || null; return { texto: r.pergunta }; }
    if (r.pendente) chat.pendente = r.pendente;
    return { texto: r.texto, change_id: r.change_id };
  });
  chat.mensagens.push({ role: 'assistant', texto: resposta.texto, em: now(), change_id: resposta.change_id });
  await saveChat(chat);
  return resposta;
}

// ======================= ROTINA =======================
export async function rotina(tenantId, { enviarResumo = false } = {}) {
  if (!(await active(tenantId, 'alex'))) return null;
  return working(tenantId, 'alex', 'Analisando os números da loja', async () => {
    const recs = await registrarRecomendacoes(tenantId);
    await revisarRecomendacoes(tenantId);
    const r = await resumoDiario(tenantId);
    await db().put('reports', { id: uid('rep_'), tenant_id: tenantId, agent: 'alex', tipo: 'resumo_diario', ...r, created_at: now() });
    log(tenantId, 'alex', `Resumo do dia pronto: ${r.ontem.pedidos} pedidos ontem, ${r.producao.hoje} para hoje, ${recs.length} recomendação(ões) em aberto`, { type: 'resumo', level: 'success' });
    return { resumo: r, recomendacoes: recs.length, enviar: enviarResumo };
  });
}
