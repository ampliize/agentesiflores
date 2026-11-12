// ALEX — gerente da floricultura: executa alterações por conversa e orienta o negócio com dados.
// Toda recomendação responde: o que aconteceu, hipótese, o que fazer agora, o que o Alex pode
// executar e quando revisar o resultado.
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
export function resumoDiario(tenantId, hoje = localDate()) {
  const ontem = addDays(hoje, -1);
  const d = periodo(tenantId, ontem, ontem);
  const mesmoDiaSemanaPassada = periodo(tenantId, addDays(ontem, -7), addDays(ontem, -7));
  const pedidosHoje = listOrders(tenantId, (o) => o.data === hoje && o.status !== 'cancelado');
  const amanha = listOrders(tenantId, (o) => o.data === addDays(hoje, 1) && o.status !== 'cancelado');
  const aguardando = listOrders(tenantId, (o) => o.status === 'aguardando_pagamento');
  const prioridades = listTasks(tenantId).filter((t) => ['aguardando_dono', 'aberta'].includes(t.status)).slice(0, 5).map((t) => `${AGENTS[t.responsavel]?.nome || t.responsavel}: ${t.titulo}`);
  const alteracoes = listChanges(tenantId).filter((c) => c.created_at.slice(0, 10) === hoje);
  return {
    data: hoje,
    ontem: { ...d, comparacao: { faturamento: variacao(d.faturamento, mesmoDiaSemanaPassada.faturamento), pedidos: variacao(d.pedidos, mesmoDiaSemanaPassada.pedidos) } },
    producao: { hoje: pedidosHoje.length, amanha: amanha.length, aguardando_pagamento: aguardando.length },
    perguntas: topPerguntas(tenantId, 3).map((q) => `${q.tema} (${q.total})`),
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

export function relatorioSemanal(tenantId, hoje = localDate()) {
  const { atual, anterior } = compararSemanas(tenantId, hoje);
  const prods = Object.fromEntries(listProducts(tenantId).map((p) => [p.id, p]));
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
export function sugestaoCompras(tenantId, hoje = localDate()) {
  const cfg = getConfig(tenantId, 'alex').compras;
  const base = periodo(tenantId, addDays(hoje, -14), addDays(hoje, -1));
  const diasBase = Math.max(1, base.dias);
  const s = getSettings(tenantId);
  const janelaFim = addDays(hoje, cfg.dias_cobertura - 1);
  const data = proximasDatas(cfg.dias_cobertura + 2, hoje).find((d) => d.peso >= 4);
  const comemorativo = (s.modo_comemorativo || []).some((m) => m.inicio <= janelaFim && m.fim >= hoje);
  const fator = data || comemorativo ? cfg.fator_data_comemorativa : 1;
  const prods = listProducts(tenantId);
  const consumo = {}; const semComposicao = [];
  for (const p of prods) {
    const vendidos = base.vendas[p.id] || 0;
    if (!vendidos) continue;
    const previsto = (vendidos / diasBase) * cfg.dias_cobertura * fator;
    if (!p.composicao?.length) { semComposicao.push(p.nome); continue; }
    for (const c of p.composicao) consumo[c.insumo_id] = (consumo[c.insumo_id] || 0) + previsto * c.qtd;
  }
  const linhas = listInsumos(tenantId).filter((i) => consumo[i.id]).map((i) => {
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
export function gerarRecomendacoes(tenantId, hoje = localDate()) {
  const rel = relatorioSemanal(tenantId, hoje);
  const s = getSettings(tenantId);
  const recs = [];
  const revisar = addDays(hoje, 7);
  const v = rel.variacoes;
  if (v.faturamento < -0.1) {
    const f = rel.funil; const pior = f.slice(1).map((e) => ({ ...e, queda: e.taxa_anterior ? (e.taxa - e.taxa_anterior) / e.taxa_anterior : 0 })).sort((a, b) => a.queda - b.queda)[0];
    let hip; let fazer;
    if (v.visitas < -0.1 && (!pior || pior.queda > -0.1)) { hip = `As visitas caíram ${pct(-v.visitas)}; a conversão se manteve. O problema parece ser atração de clientes.`; fazer = 'Reforçar divulgação: posts dos produtos mais vendidos e anúncios com melhor retorno.'; }
    else if (pior) { hip = `A etapa "${pior.label}" piorou: ${pct(pior.taxa_anterior)} → ${pct(pior.taxa)}. Clientes estão desistindo nesse ponto.`; fazer = pior.etapa === 'pedidos' ? 'Conferir pagamento e frete: frete alto ou falha no pagamento costumam causar desistência nessa etapa.' : 'Conferir preço, fotos e disponibilidade dos produtos mais vistos.'; }
    recs.push({ titulo: `Vendas da semana ${sinal(v.faturamento)}`, aconteceu: `Faturamento de ${brl(rel.atual.faturamento)} contra ${brl(rel.anterior.faturamento)} na semana anterior (visitas ${sinal(v.visitas)}, conversão ${sinal(v.conversao)}, ticket ${sinal(v.ticket)}).`, hipotese: hip, fazer_agora: fazer, alex_executa: null, revisar_em: revisar, metrica: { nome: 'faturamento_semana', inicial: rel.atual.faturamento } });
  }
  for (const pr of rel.procurados.filter((x) => x.buscas >= 15 && x.conv < 0.05).slice(0, 2)) {
    const p = getProduct(pr.id); const disp = disponibilidade(p, s);
    const a = p ? analisarProduto(tenantId, p) : null;
    recs.push({
      titulo: `${pr.nome}: muito procurado, pouco vendido`,
      aconteceu: `${pr.buscas} visualizações e ${pr.vendas} venda(s) na semana (${pct(pr.conv)}).`,
      hipotese: !disp.ok ? `O produto está indisponível (${disp.motivo}); clientes chegam até ele e não conseguem comprar.` : 'Preço, foto ou descrição podem não estar convencendo.',
      fazer_agora: !disp.ok ? 'Repor e reativar o produto, ou tirá-lo da divulgação.' : `Revisar foto e descrição; a Sol indica margem de ${a?.mc_pct != null ? pct(a.mc_pct) : 'cálculo indisponível'}, ${a?.mc_pct > 0.45 ? 'há espaço para uma condição especial' : 'pouco espaço para desconto'}.`,
      alex_executa: !disp.ok && !p.ativo ? { acao: 'ativar_produto', params: { produto: p.nome, ativo: true }, label: `Reativar ${p.nome}` } : null,
      revisar_em: revisar, metrica: { nome: 'conversao_produto', produto_id: pr.id, inicial: pr.conv },
    });
  }
  const topMargem = rel.top.map((t) => listProducts(tenantId).find((p) => p.nome === t.nome)).filter((p) => p && (p.tipo || 'produto') === 'produto')
    .map((p) => ({ p, a: analisarProduto(tenantId, p) })).filter((x) => x.a.mc_pct > 0.5 && !x.p.destaque && disponibilidade(x.p, s).ok)[0];
  if (topMargem) recs.push({
    titulo: `Destacar ${topMargem.p.nome}`,
    aconteceu: `Está entre os mais vendidos e deixa ${pct(topMargem.a.mc_pct)} de margem de contribuição (${brl(topMargem.a.mc)} por unidade).`,
    hipotese: 'Dar mais visibilidade a um produto que vende bem e deixa boa margem aumenta o resultado sem desconto.',
    fazer_agora: 'Colocar nos destaques da loja e pedir à Mari um post sobre ele.',
    alex_executa: { acao: 'destacar_produto', params: { produto: topMargem.p.nome, destaque: true }, label: `Destacar ${topMargem.p.nome}` },
    revisar_em: revisar, metrica: { nome: 'vendas_produto', produto_id: topMargem.p.id, inicial: rel.atual.vendas[topMargem.p.id] || 0 },
  });
  const baixa = rel.top.map((t) => listProducts(tenantId).find((p) => p.nome === t.nome)).filter((p) => p && (p.tipo || 'produto') === 'produto').map((p) => ({ p, a: analisarProduto(tenantId, p) })).find((x) => x.a.mc_pct != null && x.a.mc_pct < 0.35);
  if (baixa) recs.push({
    titulo: `${baixa.p.nome} vende bem, mas deixa pouco`,
    aconteceu: `Margem de contribuição de ${pct(baixa.a.mc_pct)} (${brl(baixa.a.mc)} por unidade) e resultado estimado após rateio de ${brl(baixa.a.resultado)}.`,
    hipotese: 'Mais vendas desse produto aumentam o faturamento, mas pouco o dinheiro que sobra.',
    fazer_agora: `Consultei a Sol: revise o preço ou a composição. Desconto nesse produto não é recomendado.${(() => { const d = impactoDesconto(tenantId, { produto: baixa.p, descontoPct: 10 }); return d.vendas_extra_necessarias != null ? ` Um desconto de 10% exigiria vender ${pct(d.vendas_extra_necessarias, 0)} a mais só para manter a mesma margem.` : ' Um desconto de 10% deixaria a margem negativa.'; })()}`,
    alex_executa: null, revisar_em: revisar, metrica: { nome: 'mc_produto', produto_id: baixa.p.id, inicial: baixa.a.mc_pct },
  });
  const data = proximasDatas(45, hoje).find((d) => d.peso >= 4);
  if (data && !comemorativoAtivo(s, data.data) && listProducts(tenantId).some((p) => p.comemorativo)) recs.push({
    titulo: `${data.nome} em ${data.faltam} dias`,
    aconteceu: `O catálogo comemorativo não está programado para ${data.nome} (${fmtDia(data.data)}).`,
    hipotese: 'Clientes começam a procurar presentes de 7 a 10 dias antes.',
    fazer_agora: `Programar o catálogo comemorativo, a sugestão de compras de flores e os conteúdos da data.`,
    alex_executa: { acao: 'data_comemorativa', params: { inicio: addDays(data.data, -7), fim: data.data, nome: data.nome, ativo: true }, label: `Ativar catálogo de ${fmtDia(addDays(data.data, -7))} a ${fmtDia(data.data)}` },
    revisar_em: addDays(data.data, 1), metrica: { nome: 'faturamento_semana', inicial: rel.atual.faturamento },
  });
  return recs;
}

/** Salva as recomendações como tarefas do tipo 'recomendacao' (sem duplicar). */
export function registrarRecomendacoes(tenantId) {
  return gerarRecomendacoes(tenantId).map((r) => createTask(tenantId, { responsavel: 'alex', solicitante: 'alex', tipo: 'recomendacao', titulo: r.titulo, detalhes: r.fazer_agora, acao: r.alex_executa, extra: { recomendacao: r } }));
}

/** Executa a ação proposta em uma recomendação (com aprovação do dono). */
export function executarRecomendacao(tenantId, taskId) {
  const t = getTask(taskId);
  if (!t || t.tenant_id !== tenantId) throw new Error('Recomendação não encontrada');
  if (!t.acao) { updateTask(taskId, { status: 'concluida', resultado: 'Marcada como feita pelo dono.', executada_em: now() }, 'dono'); return { texto: 'Marcada como feita.' }; }
  const r = executar(tenantId, t.acao.acao, t.acao.params, { comando: t.titulo, confirmado: true });
  updateTask(taskId, { status: r.executado ? 'concluida' : t.status, resultado: r.texto, executada_em: now(), change_id: r.change_id }, 'dono');
  return r;
}

/** Revisa recomendações executadas cuja data de revisão chegou. */
export function revisarRecomendacoes(tenantId, hoje = localDate()) {
  const feitas = listTasks(tenantId, { tipo: 'recomendacao', status: 'concluida' }).filter((t) => !t.revisada && t.recomendacao?.revisar_em <= hoje);
  for (const t of feitas) {
    const m = t.recomendacao.metrica; const rel = relatorioSemanal(tenantId, hoje);
    let atual = null;
    if (m.nome === 'faturamento_semana') atual = rel.atual.faturamento;
    if (m.nome === 'vendas_produto') atual = rel.atual.vendas[m.produto_id] || 0;
    if (m.nome === 'conversao_produto') { const b = rel.atual.buscas[m.produto_id] || 0; atual = b ? (rel.atual.vendas[m.produto_id] || 0) / b : 0; }
    const txt = atual == null ? 'Sem dados suficientes para medir.' : `Antes: ${m.inicial?.toFixed?.(2) ?? m.inicial}; agora: ${atual.toFixed(2)} (${sinal(variacao(atual, m.inicial))}). Outros fatores (sazonalidade, anúncios) também influenciam esse número.`;
    updateTask(t.id, { revisada: true, revisao: { em: now(), texto: txt } });
    log(tenantId, 'alex', `Revisou o resultado de "${t.titulo}": ${txt}`, { type: 'revisao' });
  }
  return feitas.length;
}

// ======================= CONVERSA COM O DONO =======================
export function getChat(tenantId, agente = 'alex') {
  return db().get('chats', `${tenantId}:${agente}`) || { id: `${tenantId}:${agente}`, tenant_id: tenantId, agente, mensagens: [], pendente: null };
}
export function saveChat(chat) { return db().put('chats', chat); }

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
  if (/(destaq|destac)/.test(t)) {
    const destaque = !/(tir|remov|sai)/.test(t);
    const p = t.replace(/.*(?:destaque|destaques|destacar|destaca|destaque o|destaque a)\s+(?:o |a |os |as |do |da |dos )?/, '').replace(/\s*(?:dos|nos) destaques.*/, '').replace(/^(tire|tira|remova)\s+(o |a )?/, '');
    return { acao: 'destacar_produto', params: { produto: p, destaque } };
  }
  if ((m = t.match(/^(?:alex,?\s*)?(ative|ativa|ativar|reative|reativa|desative|desativa|desativar)\s+(?:o |a )?(?:produto )?(.+?)[.!]?$/))) return { acao: 'ativar_produto', params: { produto: m[2], ativo: !/^des/.test(m[1]) } };
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
  if (!recs.length) return 'Não encontrei nada fora do normal nos dados desta semana.';
  return recs.map((r, i) => `${i + 1}. ${r.titulo}\n   O que aconteceu: ${r.aconteceu}\n   Hipótese: ${r.hipotese}\n   O que fazer agora: ${r.fazer_agora}\n   O que eu posso executar: ${r.alex_executa ? r.alex_executa.label + ' (é só aprovar em Tarefas)' : 'nada automático; depende de você'}\n   Revisar em: ${fmtDia(r.revisar_em)}`).join('\n\n');
}
function formatarCompras(c) {
  return [`Estimativa de consumo de ${fmtDia(c.periodo.de)} a ${fmtDia(c.periodo.ate)}${c.motivo_fator ? ` (×${c.fator} por ${c.motivo_fator})` : ''}:`,
    ...c.linhas.filter((l) => l.sugerido > 0).slice(0, 10).map((l) => `• ${l.insumo}: comprar ~${l.sugerido} ${l.unidade} (consumo ${l.consumo} + perda ${l.perda_pct}% − estoque ${l.estoque})`),
    `Custo estimado: ${brl(c.custo_total)}.`, ...c.limitacoes.map((x) => `Limitação: ${x}`), c.aviso].join('\n');
}
const AJUDA = 'Posso executar na loja, por exemplo:\n• "Acabou a rosa vermelha. Desative os produtos que usam essa flor."\n• "No dia 7 não teremos entregas."\n• "Ative o catálogo de data comemorativa do dia 10 ao dia 12."\n• "Atualize o estoque do Buquê Encanto para 15 unidades."\n• "Configure o frete da Vila Mariana para R$12."\n• "Dia 24 vamos abrir das 8h às 13h."\n• "Desfaça a última alteração."\nE também: "resumo do dia", "relatório da semana", "o que devo fazer?", "sugestão de compras".';

async function responderInfo(tenantId, info) {
  if (info === 'resumo') return resumoDiario(tenantId).texto;
  if (info === 'semanal') return formatarSemanal(relatorioSemanal(tenantId));
  if (info === 'compras') return formatarCompras(sugestaoCompras(tenantId));
  if (info === 'recomendacoes') { const recs = gerarRecomendacoes(tenantId); registrarRecomendacoes(tenantId); return formatarRecs(recs); }
  return AJUDA;
}

const LLM_SYSTEM = (tenantId) => `Você é o Alex, gerente da floricultura dentro do iFlores. Fale português do Brasil, direto e cordial.
Você executa alterações na loja usando as ferramentas e orienta o dono com base nos dados.
Regras:
- Use apenas as ferramentas para alterar a loja; nunca diga que fez algo que nenhuma ferramenta confirmou.
- Se faltar um dado ou houver ambiguidade (ex.: "deste produto", "desse bairro"), faça UMA pergunta curta antes de executar.
- Depois de uma alteração em lote, explique o que encontrou e o que executou, e lembre que produtos sem a informação no cadastro podem ter ficado de fora.
- Toda recomendação deve dizer: o que aconteceu, a hipótese, o que fazer agora, o que você pode executar e quando revisar.
- Antes de recomendar descontos ou promoções, consulte a análise financeira (ferramenta consultar_sol).
- Estimativas de compra não são quantidades exatas.
Hoje é ${localDate()}. Permissões: ${JSON.stringify(getConfig(tenantId, 'alex').permissoes)}. ${getConfig(tenantId, 'alex').instrucoes || ''}`;

function llmTools(tenantId, comando) {
  const typeOf = (t) => (t.startsWith('number') ? ['number', 'null'] : t.startsWith('boolean') ? ['boolean', 'null'] : ['string', 'null']);
  const tools = Object.entries(ACTIONS).map(([name, a]) => {
    const props = Object.fromEntries(Object.entries({ ...a.params, ...(name === 'desativar_por_item' ? { confirmado: 'boolean' } : {}) }).map(([k, t]) => [k, { type: typeOf(t), ...(t.startsWith('date') ? { description: 'YYYY-MM-DD' } : {}) }]));
    return { name, description: a.descricao, input_schema: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
      run: (input) => { const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v != null)); return executar(tenantId, name, clean, { comando, confirmado: !!input.confirmado }); } };
  });
  const info = (name, description, fn) => ({ name, description, input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} }, run: fn });
  tools.push(info('resumo_do_dia', 'Indicadores de ontem, produção de hoje e pendências.', () => resumoDiario(tenantId)));
  tools.push(info('relatorio_semanal', 'Comparação da semana com a anterior, funil, mais vendidos e procurados x vendidos.', () => relatorioSemanal(tenantId)));
  tools.push(info('sugestao_compras', 'Estimativa de compra de flores e insumos.', () => sugestaoCompras(tenantId)));
  tools.push(info('recomendacoes', 'Recomendações com hipótese, ação e data de revisão (registradas em Tarefas).', () => { registrarRecomendacoes(tenantId); return gerarRecomendacoes(tenantId); }));
  tools.push({ name: 'consultar_sol', description: 'Pergunta à Sol o impacto de um desconto em um produto.', input_schema: { type: 'object', additionalProperties: false, required: ['produto', 'desconto_pct'], properties: { produto: { type: 'string' }, desconto_pct: { type: 'number' } } },
    run: ({ produto, desconto_pct }) => { const p = listProducts(tenantId).find((x) => norm(x.nome).includes(norm(produto))); return p ? impactoDesconto(tenantId, { produto: p, descontoPct: desconto_pct }) : { erro: 'produto não encontrado' }; } });
  return tools;
}

export function conversar(tenantId, texto) { return serial(`${tenantId}:chat:alex`, () => conversarAgora(tenantId, texto)); }
async function conversarAgora(tenantId, texto) {
  if (!active(tenantId, 'alex')) return { texto: 'O Alex não está contratado ou está pausado nesta loja.' };
  const chat = getChat(tenantId);
  chat.mensagens.push({ role: 'user', texto, em: now() });
  const resposta = await working(tenantId, 'alex', 'Atendendo um pedido do dono', async () => {
    if (aiEnabled()) {
      const history = chat.mensagens.slice(-16).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.texto }));
      const r = await runToolLoop({ system: LLM_SYSTEM(tenantId), messages: history, tools: llmTools(tenantId, texto), effort: 'medium' });
      return { texto: r.text || 'Não consegui concluir. Pode reformular?' };
    }
    const it = interpretar(tenantId, texto, chat.pendente);
    chat.pendente = null;
    if (it.texto) return { texto: it.texto };
    if (it.info) return { texto: await responderInfo(tenantId, it.info) };
    if (it.ajuda) return { texto: AJUDA };
    const r = executar(tenantId, it.acao, it.params, { comando: texto, confirmado: it.confirmado });
    if (r.negado) return { texto: r.negado };
    if (r.pergunta) { chat.pendente = r.pendente || null; return { texto: r.pergunta }; }
    if (r.pendente) chat.pendente = r.pendente;
    return { texto: r.texto, change_id: r.change_id };
  });
  chat.mensagens.push({ role: 'assistant', texto: resposta.texto, em: now(), change_id: resposta.change_id });
  saveChat(chat);
  return resposta;
}

// ======================= ROTINA =======================
export async function rotina(tenantId, { enviarResumo = false } = {}) {
  if (!active(tenantId, 'alex')) return null;
  return working(tenantId, 'alex', 'Analisando os números da loja', () => {
    const recs = registrarRecomendacoes(tenantId);
    revisarRecomendacoes(tenantId);
    const r = resumoDiario(tenantId);
    db().put('reports', { id: uid('rep_'), tenant_id: tenantId, agent: 'alex', tipo: 'resumo_diario', ...r, created_at: now() });
    log(tenantId, 'alex', `Resumo do dia pronto: ${r.ontem.pedidos} pedidos ontem, ${r.producao.hoje} para hoje, ${recs.length} recomendação(ões) em aberto`, { type: 'resumo', level: 'success' });
    return { resumo: r, recomendacoes: recs.length, enviar: enviarResumo };
  });
}
