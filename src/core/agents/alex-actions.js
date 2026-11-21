// Ações que o Alex executa na loja. Cada ação:
//   • confere a permissão concedida pelo lojista;
//   • pergunta antes quando há ambiguidade ({ pergunta });
//   • registra histórico com opção de desfazer (applyChanges);
//   • explica o que encontrou e o que executou.
import { db } from '../store.js';
import { getConfig } from '../team.js';
import {
  listProducts, produtosComItem, acharProduto, getSettings, applyChanges, listChanges, undoChange, disponibilidade, getProduct,
} from '../catalog.js';
import { createTask } from '../tasks.js';
import { brl, fmtDia, norm, localDate } from '../util.js';

const settingsOp = (tenantId, patch) => ({ coll: 'settings', id: tenantId, after: { ...getSettings(tenantId), ...patch } });
const prodOp = (p, patch) => ({ coll: 'products', id: p.id, after: { ...p, ...patch } });
function permitido(tenantId, area) {
  const p = getConfig(tenantId, 'alex').permissoes || {};
  if (p[area] === false) return { negado: `Não tenho permissão para alterar ${area}. Você pode liberar em Configurar → Alex → Permissões.` };
  return null;
}
const lista = (ps, max = 15) => ps.slice(0, max).map((x) => `• ${x.p ? `${x.p.nome} (${x.por === 'composição' ? 'pelo cadastro de composição' : x.por === 'nome' ? 'pelo nome' : 'pela descrição'})` : x.nome}`).join('\n') + (ps.length > max ? `\n• … e mais ${ps.length - max}` : '');

export const ACTIONS = {
  desativar_por_item: {
    descricao: 'Desativa os produtos que usam uma flor ou insumo (ex.: "rosa vermelha"), identificando pelo cadastro de composição, nome ou descrição.',
    params: { item: 'string' },
    run(tenantId, { item }, ctx) {
      const neg = permitido(tenantId, 'produtos'); if (neg) return neg;
      const achados = produtosComItem(tenantId, item).filter((x) => x.p.ativo);
      if (!achados.length) return { texto: `Não encontrei produtos ativos com "${item}" no nome, na descrição ou na composição. Nada foi alterado.` };
      const limite = getConfig(tenantId, 'alex').confirmar_lote_acima;
      if (achados.length > limite && !ctx?.confirmado) return { pergunta: `Encontrei ${achados.length} produtos com "${item}". É um lote grande: confirma que posso desativar todos?`, pendente: { acao: 'desativar_por_item', params: { item } } };
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Desativou ${achados.length} produto(s) com "${item}"`, ops: achados.map((x) => prodOp(x.p, { ativo: false, desativado_motivo: `sem ${item}` })) });
      return { executado: true, change_id: change.id, texto: `Desativei ${achados.length} produto(s) identificados com "${item}" pelo nome ou pela composição:\n${lista(achados)}\n\nProdutos sem essa informação no cadastro podem ter ficado de fora. Confira a lista. A Flora já deixou de oferecê-los, a Mari revisou as publicações programadas e o Caio verificou os anúncios.` };
    },
  },
  reativar_por_item: {
    descricao: 'Reativa produtos que foram desativados por falta de uma flor/insumo.',
    params: { item: 'string' },
    run(tenantId, { item }, ctx) {
      const neg = permitido(tenantId, 'produtos'); if (neg) return neg;
      const achados = produtosComItem(tenantId, item).filter((x) => !x.p.ativo);
      if (!achados.length) return { texto: `Não há produtos desativados com "${item}".` };
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Reativou ${achados.length} produto(s) com "${item}"`, ops: achados.map((x) => prodOp(x.p, { ativo: true, desativado_motivo: null })) });
      return { executado: true, change_id: change.id, texto: `Reativei ${achados.length} produto(s) com "${item}":\n${lista(achados)}` };
    },
  },
  ativar_produto: {
    descricao: 'Ativa ou desativa um produto pelo nome.',
    params: { produto: 'string', ativo: 'boolean' },
    run(tenantId, { produto, ativo }, ctx) {
      const neg = permitido(tenantId, 'produtos'); if (neg) return neg;
      const ps = acharProduto(tenantId, produto);
      if (!ps.length) return { pergunta: `Não encontrei o produto "${produto}". Qual é o nome dele no catálogo?` };
      if (ps.length > 1) return { pergunta: `Encontrei mais de um produto: ${ps.map((p) => p.nome).join(' ou ')}. Qual deles?` };
      const p = ps[0];
      if (p.ativo === ativo) return { texto: `${p.nome} já está ${ativo ? 'ativo' : 'desativado'}.` };
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `${ativo ? 'Ativou' : 'Desativou'} ${p.nome}`, ops: [prodOp(p, { ativo })] });
      return { executado: true, change_id: change.id, texto: `${ativo ? 'Ativei' : 'Desativei'} ${p.nome}.` };
    },
  },
  atualizar_estoque: {
    descricao: 'Atualiza a quantidade em estoque de um produto.',
    params: { produto: 'string', quantidade: 'number' },
    run(tenantId, { produto, quantidade }, ctx) {
      const neg = permitido(tenantId, 'estoque'); if (neg) return neg;
      if (!produto || /^(deste|desse|este|esse) produto$/.test(norm(produto))) return { pergunta: `Para qual produto devo colocar ${quantidade} unidades?`, pendente: { acao: 'atualizar_estoque', params: { quantidade }, falta: 'produto' } };
      const ps = acharProduto(tenantId, produto);
      if (!ps.length) return { pergunta: `Não encontrei "${produto}". Qual é o nome do produto?`, pendente: { acao: 'atualizar_estoque', params: { quantidade }, falta: 'produto' } };
      if (ps.length > 1) return { pergunta: `Qual deles: ${ps.map((p) => p.nome).join(' ou ')}?`, pendente: { acao: 'atualizar_estoque', params: { quantidade }, falta: 'produto' } };
      const p = ps[0];
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Estoque de ${p.nome}: ${p.estoque ?? 'sob encomenda'} → ${quantidade}`, ops: [prodOp(p, { estoque: quantidade })] });
      return { executado: true, change_id: change.id, texto: `Atualizei o estoque de ${p.nome} para ${quantidade} unidade(s) (antes: ${p.estoque ?? 'sob encomenda'}).` };
    },
  },
  destacar_produto: {
    descricao: 'Coloca ou retira um produto dos destaques da loja.',
    params: { produto: 'string', destaque: 'boolean' },
    run(tenantId, { produto, destaque }, ctx) {
      const neg = permitido(tenantId, 'categorias'); if (neg) return neg;
      const ps = acharProduto(tenantId, produto);
      if (ps.length !== 1) return { pergunta: ps.length ? `Qual deles: ${ps.map((p) => p.nome).join(' ou ')}?` : `Não encontrei "${produto}". Qual produto?` };
      const p = ps[0];
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `${destaque ? 'Destacou' : 'Tirou dos destaques'} ${p.nome}`, ops: [prodOp(p, { destaque })] });
      return { executado: true, change_id: change.id, texto: `${destaque ? 'Coloquei' : 'Tirei'} ${p.nome} ${destaque ? 'nos' : 'dos'} destaques.` };
    },
  },
  mudar_categoria: {
    descricao: 'Muda a categoria de um produto.',
    params: { produto: 'string', categoria: 'string' },
    run(tenantId, { produto, categoria }, ctx) {
      const neg = permitido(tenantId, 'categorias'); if (neg) return neg;
      const ps = acharProduto(tenantId, produto);
      if (ps.length !== 1) return { pergunta: ps.length ? `Qual deles: ${ps.map((p) => p.nome).join(' ou ')}?` : `Não encontrei "${produto}".` };
      const s = getSettings(tenantId); const ops = [prodOp(ps[0], { categoria })];
      if (!s.categorias.includes(categoria)) ops.push(settingsOp(tenantId, { categorias: [...s.categorias, categoria] }));
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Moveu ${ps[0].nome} para ${categoria}`, ops });
      return { executado: true, change_id: change.id, texto: `Movi ${ps[0].nome} para a categoria ${categoria}.` };
    },
  },
  bloquear_data: {
    descricao: 'Bloqueia entregas, retiradas e/ou pedidos em uma data. Os outros dias continuam normais.',
    params: { data: 'date', entrega: 'boolean', retirada: 'boolean', pedidos: 'boolean', motivo: 'string?' },
    run(tenantId, { data, entrega = true, retirada = false, pedidos = false, motivo = '' }, ctx) {
      const neg = permitido(tenantId, 'datas'); if (neg) return neg;
      if (!data) return { pergunta: 'Qual data devo bloquear?' };
      const s = getSettings(tenantId);
      const outras = s.datas_bloqueadas.filter((b) => b.data !== data);
      const b = { data, entrega: entrega || pedidos, retirada: retirada || pedidos, pedidos, motivo };
      const afetados = db().list('orders', tenantId, (o) => o.data === data && o.status !== 'cancelado' && (b.pedidos || b[o.modalidade]));
      const o = [];
      if (b.pedidos) o.push('sem atendimento'); else { if (b.entrega) o.push('sem entregas'); if (b.retirada) o.push('sem retiradas'); }
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Dia ${fmtDia(data)}: ${o.join(' e ')}`, ops: [settingsOp(tenantId, { datas_bloqueadas: [...outras, b].sort((x, y) => (x.data < y.data ? -1 : 1)) })] });
      let texto = `Pronto: no dia ${fmtDia(data)} ficamos ${o.join(' e ')}. Os pedidos para os outros dias continuam abertos normalmente.`;
      if (!b.pedidos && !b.retirada && b.entrega) texto += ` A retirada na loja no dia ${fmtDia(data)} continua liberada. Quer bloquear também?`;
      if (afetados.length) texto += `\n\nAtenção: já existem ${afetados.length} pedido(s) para esse dia (${afetados.map((x) => '#' + x.numero).join(', ')}). Eles não foram alterados.`;
      return { executado: true, change_id: change.id, texto, ...(b.entrega && !b.retirada && !b.pedidos ? { pendente: { acao: 'bloquear_data', params: { data, entrega: true, retirada: true, motivo } } } : {}) };
    },
  },
  liberar_data: {
    descricao: 'Remove o bloqueio de uma data.',
    params: { data: 'date' },
    run(tenantId, { data }, ctx) {
      const neg = permitido(tenantId, 'datas'); if (neg) return neg;
      const s = getSettings(tenantId);
      if (!s.datas_bloqueadas.some((b) => b.data === data)) return { texto: `O dia ${fmtDia(data)} não está bloqueado.` };
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Liberou o dia ${fmtDia(data)}`, ops: [settingsOp(tenantId, { datas_bloqueadas: s.datas_bloqueadas.filter((b) => b.data !== data) })] });
      return { executado: true, change_id: change.id, texto: `Liberei o dia ${fmtDia(data)} para entregas, retiradas e pedidos.` };
    },
  },
  horario_especial: {
    descricao: 'Define horário especial de funcionamento em uma data (ou loja fechada).',
    params: { data: 'date', abre: 'HH:MM?', fecha: 'HH:MM?', fechado: 'boolean' },
    run(tenantId, { data, abre, fecha, fechado, motivo = '' }, ctx) {
      const neg = permitido(tenantId, 'horarios'); if (neg) return neg;
      if (!data) return { pergunta: 'Para qual dia é o horário especial?' };
      if (!fechado && (!abre || !fecha)) return { pergunta: `Qual o horário do dia ${fmtDia(data)}? Ex.: das 9h às 14h.` };
      const s = getSettings(tenantId);
      const h = { data, abre: fechado ? null : abre, fecha: fechado ? null : fecha, motivo };
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Horário especial ${fmtDia(data)}: ${fechado ? 'fechado' : `${abre}–${fecha}`}`, ops: [settingsOp(tenantId, { horarios_especiais: [...s.horarios_especiais.filter((x) => x.data !== data), h] })] });
      return { executado: true, change_id: change.id, texto: fechado ? `Marquei a loja como fechada no dia ${fmtDia(data)}.` : `Horário do dia ${fmtDia(data)}: das ${abre} às ${fecha}. A Flora e a Mari já usam esse horário.` };
    },
  },
  receber_pedidos: {
    descricao: 'Pausa ou retoma o recebimento de novos pedidos.',
    params: { ativo: 'boolean' },
    run(tenantId, { ativo }, ctx) {
      const neg = permitido(tenantId, 'pedidos'); if (neg) return neg;
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: ativo ? 'Retomou o recebimento de pedidos' : 'Pausou o recebimento de pedidos', ops: [settingsOp(tenantId, { recebendo_pedidos: !!ativo })] });
      return { executado: true, change_id: change.id, texto: ativo ? 'Voltamos a receber pedidos.' : 'Pausei o recebimento de novos pedidos. A Flora vai avisar os clientes e anotar os contatos.' };
    },
  },
  data_comemorativa: {
    descricao: 'Ativa o catálogo de data comemorativa em um período (ou desativa).',
    params: { inicio: 'date', fim: 'date', nome: 'string?', ativo: 'boolean' },
    run(tenantId, { inicio, fim, nome = 'Data comemorativa', ativo = true }, ctx) {
      const neg = permitido(tenantId, 'data_comemorativa'); if (neg) return neg;
      const s = getSettings(tenantId);
      if (!ativo) {
        if (!s.modo_comemorativo.length) return { texto: 'Não há catálogo comemorativo programado.' };
        const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: 'Desativou o catálogo de data comemorativa', ops: [settingsOp(tenantId, { modo_comemorativo: [] })] });
        return { executado: true, change_id: change.id, texto: 'Desativei o catálogo de data comemorativa.' };
      }
      if (!inicio || !fim) return { pergunta: 'De qual dia até qual dia devo ativar o catálogo comemorativo?' };
      const prods = listProducts(tenantId).filter((p) => p.comemorativo);
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Catálogo comemorativo de ${fmtDia(inicio)} a ${fmtDia(fim)}`, ops: [settingsOp(tenantId, { modo_comemorativo: [...s.modo_comemorativo.filter((m) => m.fim < localDate()), { nome, inicio, fim }] })] });
      return { executado: true, change_id: change.id, texto: `Ativei o catálogo de data comemorativa de ${fmtDia(inicio)} a ${fmtDia(fim)}. ${prods.length} produto(s) comemorativo(s) ficam à venda nesse período: ${prods.map((p) => p.nome).join(', ') || 'nenhum cadastrado ainda'}.` };
    },
  },
  configurar_frete: {
    descricao: 'Define o valor do frete de um bairro (cria o bairro se não existir).',
    params: { bairro: 'string', valor: 'number' },
    run(tenantId, { bairro, valor }, ctx) {
      const neg = permitido(tenantId, 'fretes'); if (neg) return neg;
      if (!bairro || /^(desse|deste|esse|este) bairro$/.test(norm(bairro))) return { pergunta: `Qual é o bairro que vai ter frete de ${brl(valor)}?`, pendente: { acao: 'configurar_frete', params: { valor }, falta: 'bairro' } };
      if (valor == null) return { pergunta: `Qual o valor do frete para ${bairro}?` };
      const s = getSettings(tenantId);
      const atual = s.fretes.find((f) => norm(f.bairro) === norm(bairro));
      const fretes = atual ? s.fretes.map((f) => (f === atual ? { ...f, valor, ativo: true } : f)) : [...s.fretes, { bairro, valor, ativo: true }];
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Frete ${atual?.bairro || bairro}: ${atual ? brl(atual.valor) : 'novo'} → ${brl(valor)}`, ops: [settingsOp(tenantId, { fretes })] });
      return { executado: true, change_id: change.id, texto: atual ? `Frete de ${atual.bairro} alterado de ${brl(atual.valor)} para ${brl(valor)}.` : `Passamos a entregar em ${bairro} com frete de ${brl(valor)}.` };
    },
  },
  destacar_na_home: {
    descricao: 'Coloca um produto em primeiro na página inicial, mantendo os demais destaques atrás (destaque=false tira da página inicial).',
    params: { produto: 'string', destaque: 'boolean?' },
    run(tenantId, { produto, destaque = true }, ctx) {
      const neg = permitido(tenantId, 'categorias'); if (neg) return neg;
      const ps = acharProduto(tenantId, produto);
      if (!ps.length) return { pergunta: `Não encontrei "${produto}" no catálogo. Qual é o nome do produto?` };
      if (ps.length > 1) return { pergunta: `Qual deles: ${ps.map((p) => p.nome).join(' ou ')}?` };
      const p = ps[0]; const s = getSettings(tenantId); const atuais = s.destaques_home || [];
      if (destaque && !disponibilidade(p, s).ok) return { texto: `${p.nome} está indisponível (${disponibilidade(p, s).motivo}), então não coloquei na página inicial.` };
      const nova = destaque ? [p.id, ...atuais.filter((id) => id !== p.id)].slice(0, 6) : atuais.filter((id) => id !== p.id);
      const nomes = (ids) => ids.map((id) => getProduct(id)?.nome).filter(Boolean).join(', ') || 'nenhum';
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: destaque ? `${p.nome} em primeiro na página inicial` : `${p.nome} fora da página inicial`, ops: [settingsOp(tenantId, { destaques_home: nova })] });
      return { executado: true, change_id: change.id, texto: destaque ? `Coloquei ${p.nome} em primeiro na página inicial. Ordem agora: ${nomes(nova)}. Antes: ${nomes(atuais)}.` : `Tirei ${p.nome} da página inicial. Ordem agora: ${nomes(nova)}.` };
    },
  },
  definir_destaques: {
    descricao: 'Define os produtos da página inicial, na ordem em que devem aparecer (até 6). Produtos indisponíveis são deixados de fora.',
    params: { ids: 'string[]?', produtos: 'string[]?' },
    run(tenantId, { ids, produtos }, ctx) {
      const neg = permitido(tenantId, 'categorias'); if (neg) return neg;
      const s = getSettings(tenantId);
      let lista = (ids || []).map(getProduct).filter((p) => p && p.tenant_id === tenantId);
      if (!lista.length && produtos?.length) lista = produtos.map((n) => acharProduto(tenantId, n)).flat().filter((p) => p.tenant_id === tenantId);
      if (!lista.length) return { pergunta: 'Quais produtos devo colocar nos destaques da página inicial, e em que ordem?' };
      const indisponiveis = lista.filter((p) => !disponibilidade(p, s).ok);
      lista = lista.filter((p) => disponibilidade(p, s).ok).slice(0, 6);
      if (!lista.length) return { texto: `Não coloquei nenhum: ${indisponiveis.map((p) => p.nome).join(', ')} estão indisponíveis.` };
      const antes = (s.destaques_home || []).map((id) => getProduct(id)?.nome).filter(Boolean);
      const change = applyChanges(tenantId, { actor: 'alex', comando: ctx?.comando, descricao: `Destaques da página inicial: ${lista.map((p) => p.nome).join(', ')}`, ops: [settingsOp(tenantId, { destaques_home: lista.map((p) => p.id) })] });
      const aviso = indisponiveis.length ? ` Deixei de fora ${indisponiveis.map((p) => p.nome).join(', ')} porque estão indisponíveis.` : '';
      return { executado: true, change_id: change.id, texto: `Coloquei na página inicial, nesta ordem: ${lista.map((p) => p.nome).join(', ')}. Antes eram: ${antes.join(', ') || 'nenhum'}.${aviso}` };
    },
  },
  pedir_campanha: {
    descricao: 'Pede ao Caio uma proposta de campanha para um produto. Nada é publicado sem aprovação e o teto de gasto é respeitado.',
    params: { produto_id: 'string' },
    run(tenantId, { produto_id }, ctx) {
      const p = getProduct(produto_id);
      if (!p || p.tenant_id !== tenantId) return { texto: 'Não encontrei esse produto.' };
      createTask(tenantId, { responsavel: 'caio', solicitante: 'alex', tipo: 'pedido', titulo: `Propor campanha para ${p.nome}`, detalhes: 'Pedido do Alex com base em margem e vendas. Respeitar o teto de gasto.' });
      return { executado: true, texto: `Pedi ao Caio uma proposta de campanha para ${p.nome}. Ela aparece em Tarefas para sua aprovação.` };
    },
  },
  desfazer: {
    descricao: 'Desfaz a última alteração (ou uma alteração específica do histórico).',
    params: { change_id: 'string?' },
    run(tenantId, { change_id }) {
      const c = change_id ? db().get('changes', change_id) : listChanges(tenantId).find((x) => !x.revertida);
      if (!c) return { texto: 'Não há alterações para desfazer.' };
      undoChange(tenantId, c.id, 'dono');
      return { executado: true, texto: `Desfiz: ${c.descricao}.` };
    },
  },
};

export function executar(tenantId, acao, params, ctx = {}) {
  const a = ACTIONS[acao];
  if (!a) throw new Error(`Ação desconhecida: ${acao}`);
  return a.run(tenantId, params || {}, ctx);
}

export const produtosIndisponiveis = (tenantId) => {
  const s = getSettings(tenantId);
  return listProducts(tenantId).filter((p) => !disponibilidade(p, s).ok);
};
