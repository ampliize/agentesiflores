// CAIO — tráfego pago (Meta e Google). O lojista define o teto; o Caio nunca o aumenta sozinho.
// Decisões consideram margem (Sol) e capacidade da loja; aumentar verba não é resposta automática.
import { db } from '../store.js';
import { getConfig, saveConfig, active, hired, getTenant } from '../team.js';
import { log, working, domain } from '../events.js';
import { createTask } from '../tasks.js';
import { getProduct, getSettings, disponibilidade, listProducts } from '../catalog.js';
import { analisarProduto } from '../finance.js';
import { periodo } from '../orders.js';
import { proximasDatas } from '../calendar.js';
import { criativoAnuncio } from './mari.js';
import { renderSlideSvg, svgDataUrl } from '../art.js';
import { brl, pct, uid, now, localDate, addDays, round2 } from '../util.js';

export const listCampaigns = (tenantId) => db().list('campaigns', tenantId).sort((a, b) => (a.status === b.status ? a.nome.localeCompare(b.nome) : a.status === 'ativa' ? -1 : 1));
const save = (c) => db().put('campaigns', c);
const gastoDiarioAtivo = (tenantId) => listCampaigns(tenantId).filter((c) => c.status === 'ativa').reduce((s, c) => s + c.orcamento_diario, 0);

/** Margem e ROAS de equilíbrio dos produtos de uma campanha (dados da Sol). */
function economia(tenantId, c) {
  const as = (c.produto_ids || []).map((id) => analisarProduto(tenantId, getProduct(id))).filter((a) => a.mc_pct != null);
  if (!as.length) return { mc_pct: null, roas_equilibrio: null };
  const mc = as.reduce((s, a) => s + a.mc_pct, 0) / as.length;
  return { mc_pct: mc, roas_equilibrio: mc > 0 ? 1 / mc : null };
}

/** Verba inicial de teste sugerida, compatível com o ticket médio e o teto. */
export function verbaTeste(tenantId) {
  const cfg = getConfig(tenantId, 'caio');
  const p = periodo(tenantId, addDays(localDate(), -30), addDays(localDate(), -1));
  const ticket = p.ticket || 140;
  const cpa = Math.min(cfg.cpa_maximo, ticket * 0.25);
  const diaria = Math.min(cfg.teto_diario, Math.max(20, Math.round((cpa * 10) / 7)));
  return { diaria, semanas: 2, total: diaria * 14, raciocinio: `Para aprender, cada campanha precisa de cerca de 10 vendas por semana. Com CPA alvo de ${brl(cpa)} (25% do ticket médio de ${brl(ticket)}), isso dá ${brl(diaria)}/dia por 2 semanas, dentro do teto de ${brl(cfg.teto_diario)}/dia.` };
}

export function avaliar(tenantId) {
  const cfg = getConfig(tenantId, 'caio'); const s = getSettings(tenantId); const r = cfg.regras;
  const capacidade = s.capacidade_pedidos_dia; const media = periodo(tenantId, addDays(localDate(), -7), addDays(localDate(), -1));
  const ocupacao = media.dias ? media.pedidos / media.dias / capacidade : 0;
  const out = [];
  for (const c of listCampaigns(tenantId).filter((x) => x.status === 'ativa')) {
    const m = c.metricas; const eco = economia(tenantId, c);
    const indis = (c.produto_ids || []).map(getProduct).filter((p) => !disponibilidade(p, s).ok);
    if (indis.length && indis.length === c.produto_ids.length) { out.push({ c, acao: 'pausar', motivo: `Divulga produto indisponível (${indis.map((p) => p.nome).join(', ')})` }); continue; }
    if (m.gasto >= r.pausar_sem_venda_apos_gasto && !m.compras) { out.push({ c, acao: 'pausar', motivo: `Gastou ${brl(m.gasto)} sem nenhuma compra identificada` }); continue; }
    if (m.impressoes > 2000 && m.ctr < r.pausar_ctr_abaixo) { out.push({ c, acao: 'pausar', motivo: `Taxa de cliques de ${String(m.ctr).replace('.', ',')}% (mínimo ${r.pausar_ctr_abaixo}%)` }); continue; }
    if (eco.roas_equilibrio && m.roas < eco.roas_equilibrio && m.gasto > 50) { out.push({ c, acao: 'pausar', motivo: `ROAS ${m.roas.toFixed(1).replace('.', ',')} abaixo do equilíbrio de ${eco.roas_equilibrio.toFixed(1).replace('.', ',')} (com margem de ${pct(eco.mc_pct)}, cada venda paga pelo anúncio dá prejuízo)` }); continue; }
    if (m.roas >= r.escalar_roas_acima) {
      const novo = Math.round(c.orcamento_diario * (1 + r.escalar_pct / 100));
      const bloqueios = [];
      if (eco.mc_pct != null && eco.mc_pct * 100 < cfg.margem_minima_para_escalar_pct) bloqueios.push(`margem de ${pct(eco.mc_pct)} abaixo de ${cfg.margem_minima_para_escalar_pct}%`);
      if (ocupacao > 0.85) bloqueios.push(`a produção já está em ${pct(ocupacao, 0)} da capacidade`);
      if (bloqueios.length) { out.push({ c, acao: 'manter', motivo: `ROAS bom (${m.roas.toFixed(1).replace('.', ',')}), mas não vou aumentar: ${bloqueios.join(' e ')}` }); continue; }
      const total = gastoDiarioAtivo(tenantId) - c.orcamento_diario + novo;
      if (total > cfg.teto_diario) out.push({ c, acao: 'pedir_teto', novo, motivo: `ROAS ${m.roas.toFixed(1).replace('.', ',')}: vale investir mais, mas o aumento para ${brl(novo)}/dia passaria o teto de ${brl(cfg.teto_diario)}/dia` });
      else out.push({ c, acao: 'escalar', novo, motivo: `ROAS ${m.roas.toFixed(1).replace('.', ',')} e margem ${eco.mc_pct != null ? pct(eco.mc_pct) : 'não calculada'}: orçamento ${brl(c.orcamento_diario)} → ${brl(novo)}/dia (dentro do teto)` });
    }
  }
  return { decisoes: out, ocupacao };
}

function executarDecisao(tenantId, d, por = 'caio') {
  if (d.acao === 'pausar') { save({ ...d.c, status: 'pausada', pausada_por: d.motivo }); log(tenantId, 'caio', `Pausou "${d.c.nome}" (${d.c.plataforma}): ${d.motivo}`, { type: 'campanha', kind: 'acao', level: 'warning' }); }
  if (d.acao === 'escalar') { save({ ...d.c, orcamento_diario: d.novo }); log(tenantId, 'caio', `Ajustou "${d.c.nome}": ${d.motivo}`, { type: 'campanha', kind: 'acao', level: 'success' }); }
  if (d.acao === 'ativar') { save({ ...d.c, status: 'ativa', pausada_por: null }); log(tenantId, 'caio', `Reativou "${d.c.nome}"`, { type: 'campanha', kind: 'acao' }); }
}

/** Criativo: aproveita a Mari se estiver contratada; senão, usa a ferramenta própria do Caio. */
function criativo(tenantId, produtoId, mensagem) {
  if (active(tenantId, 'mari')) {
    const pronto = db().list('posts', tenantId, (p) => p.formato === 'anuncio' && p.status === 'aprovado' && p.produto_ids.includes(produtoId))[0];
    if (pronto) return { post_id: pronto.id, origem: 'peça aprovada da Mari' };
    const novo = criativoAnuncio(tenantId, produtoId, mensagem);
    return { post_id: novo.id, origem: 'pedido à Mari (aguarda aprovação)' };
  }
  const p = getProduct(produtoId); const foto = db().list('photos', tenantId, (f) => f.produto_id === produtoId)[0];
  const svg = renderSlideSvg({ formato: 'anuncio', foto: foto?.url, titulo: mensagem.split(' ').slice(0, 5).join(' '), subtitulo: p.nome, preco: brl(p.preco), cta: 'Compre agora', loja: getTenant(tenantId).name, cores: ['#1c6dd0', '#14324f', '#f4f7fb'] });
  const post = db().put('posts', { id: uid('post_'), tenant_id: tenantId, formato: 'anuncio', tema: `anúncio: ${mensagem}`, produto_ids: [produtoId], criado_por: 'caio', status: 'aguardando_aprovacao', legenda: `${mensagem}. ${p.nome} por ${brl(p.preco)}.`, slides: [{ titulo: mensagem, imagem: svgDataUrl(svg), produto_id: produtoId }], precos_usados: { [produtoId]: p.preco } });
  return { post_id: post.id, origem: 'ferramenta de criativos do Caio' };
}

/** Propostas de novas campanhas: datas comemorativas e produtos de boa margem. */
function propostas(tenantId) {
  const cfg = getConfig(tenantId, 'caio'); const s = getSettings(tenantId);
  const ativos = listProducts(tenantId).filter((p) => (p.tipo || 'produto') === 'produto' && disponibilidade(p, s).ok).map((p) => ({ p, a: analisarProduto(tenantId, p) })).filter((x) => x.a.mc_pct != null).sort((a, b) => b.a.mc - a.a.mc);
  const out = []; const data = proximasDatas(45).find((d) => d.peso >= 4); const vt = verbaTeste(tenantId);
  const existentes = new Set(listCampaigns(tenantId).map((c) => c.nome));
  if (data && ativos[0]) {
    const nome = `${data.nome} — ${ativos[0].p.nome}`;
    if (!existentes.has(nome)) out.push({ nome, plataforma: cfg.plataformas.meta ? 'meta' : 'google', produto_ids: [ativos[0].p.id], orcamento_diario: vt.diaria, mensagem: `Presente para ${data.nome} com entrega garantida`, justificativa: `${data.nome} em ${data.faltam} dias. ${ativos[0].p.nome} tem a maior margem por unidade (${brl(ativos[0].a.mc)}, ${pct(ativos[0].a.mc_pct)}).` });
  }
  if (cfg.plataformas.google && !listCampaigns(tenantId).some((c) => c.plataforma === 'google' && c.tipo === 'pesquisa')) {
    out.push({ nome: `Pesquisa: floricultura ${cfg.regiao.cidade}`, plataforma: 'google', tipo: 'pesquisa', produto_ids: ativos.slice(0, 3).map((x) => x.p.id), orcamento_diario: Math.min(25, vt.diaria), mensagem: 'Flores com entrega no mesmo dia', palavras: [`floricultura ${cfg.regiao.cidade.toLowerCase()}`, 'entrega de flores hoje', 'buquê de rosas entrega'], justificativa: 'Captura quem já está procurando flores na região.' });
  }
  return out;
}

export async function analisar(tenantId, { motivo = 'análise programada' } = {}) {
  if (!active(tenantId, 'caio')) return null;
  const cfg = getConfig(tenantId, 'caio');
  return working(tenantId, 'caio', 'Analisando campanhas', () => {
    const { decisoes, ocupacao } = avaliar(tenantId);
    for (const d of decisoes) {
      if (d.acao === 'manter') { log(tenantId, 'caio', `${d.c.nome}: ${d.motivo}`, { type: 'analise' }); continue; }
      if (d.acao === 'pedir_teto') { createTask(tenantId, { responsavel: 'caio', solicitante: 'caio', tipo: 'sugestao', titulo: `Aumentar o teto diário para ${brl(cfg.teto_diario + (d.novo - d.c.orcamento_diario))}?`, detalhes: `${d.c.nome}: ${d.motivo}. Só aumento com a sua autorização.`, acao: { acao: 'aumentar_teto', params: { novo_teto: cfg.teto_diario + (d.novo - d.c.orcamento_diario), campanha_id: d.c.id, novo_orcamento: d.novo } } }); continue; }
      if (cfg.autonomia === 'sugerir') { createTask(tenantId, { responsavel: 'caio', solicitante: 'caio', tipo: 'sugestao', titulo: `${d.acao === 'pausar' ? 'Pausar' : 'Ajustar'} "${d.c.nome}"`, detalhes: d.motivo, acao: { acao: d.acao, params: { campanha_id: d.c.id, novo: d.novo } } }); continue; }
      executarDecisao(tenantId, d);
    }
    for (const pr of propostas(tenantId)) {
      const cr = criativo(tenantId, pr.produto_ids[0], pr.mensagem);
      createTask(tenantId, { responsavel: 'caio', solicitante: 'caio', tipo: 'sugestao', titulo: `Criar campanha "${pr.nome}" (${brl(pr.orcamento_diario)}/dia)`, detalhes: `${pr.justificativa} Criativo: ${cr.origem}.`, acao: { acao: 'criar_campanha', params: { ...pr, criativo_post_id: cr.post_id } } });
    }
    const cs = listCampaigns(tenantId); const g = cs.reduce((s, c) => s + c.metricas.gasto, 0); const rec = cs.reduce((s, c) => s + c.metricas.receita, 0);
    const rep = { id: uid('rep_'), tenant_id: tenantId, agent: 'caio', tipo: 'analise', created_at: now(), gasto_7d: round2(g), receita_7d: round2(rec), roas: g ? rec / g : 0, gasto_diario_ativo: gastoDiarioAtivo(tenantId), teto_diario: cfg.teto_diario, ocupacao, decisoes: decisoes.map((d) => ({ campanha: d.c.nome, acao: d.acao, motivo: d.motivo })), verba_teste: verbaTeste(tenantId) };
    db().put('reports', rep);
    log(tenantId, 'caio', `Análise concluída (${motivo}): gasto de ${brl(g)} em 7 dias, ${brl(rec)} em compras identificáveis, ${decisoes.filter((d) => d.acao !== 'manter').length} ajuste(s)`, { type: 'analise', level: 'success' });
    return rep;
  });
}

/** Execução aprovada pelo dono (a partir de uma sugestão). */
export function executarAprovado(tenantId, acao, params) {
  const cfg = getConfig(tenantId, 'caio');
  if (acao === 'aumentar_teto') {
    saveConfig(tenantId, 'caio', { teto_diario: params.novo_teto });
    const c = db().get('campaigns', params.campanha_id); if (c) save({ ...c, orcamento_diario: params.novo_orcamento });
    log(tenantId, 'caio', `Teto diário aumentado para ${brl(params.novo_teto)} com autorização do dono`, { type: 'teto', kind: 'acao', level: 'success' });
    return { texto: 'Teto aumentado e campanha ajustada.' };
  }
  if (acao === 'criar_campanha') {
    if (gastoDiarioAtivo(tenantId) + params.orcamento_diario > cfg.teto_diario) return { texto: `Não criei: a campanha passaria o teto diário de ${brl(cfg.teto_diario)}. Pause outra campanha ou aumente o teto.` };
    const c = save({ id: uid('cmp_'), tenant_id: tenantId, plataforma: params.plataforma, tipo: params.tipo || 'conversao', nome: params.nome, status: 'ativa', orcamento_diario: params.orcamento_diario, produto_ids: params.produto_ids, criativo_post_id: params.criativo_post_id, palavras: params.palavras, criada_por: 'caio', metricas: { gasto: 0, impressoes: 0, cliques: 0, ctr: 0, compras: 0, receita: 0, roas: 0 } });
    log(tenantId, 'caio', `Criou a campanha "${c.nome}" no ${c.plataforma === 'meta' ? 'Meta Ads' : 'Google Ads'} com ${brl(c.orcamento_diario)}/dia (aprovada pelo dono)`, { type: 'campanha', kind: 'acao', level: 'success' });
    return { texto: `Campanha "${c.nome}" criada.` };
  }
  const c = db().get('campaigns', params.campanha_id); if (!c) throw new Error('Campanha não encontrada');
  executarDecisao(tenantId, { c, acao, novo: params.novo, motivo: 'aprovado pelo dono' });
  return { texto: 'Feito.' };
}

export function pausarManual(tenantId, id) { const c = db().get('campaigns', id); if (c?.tenant_id === tenantId) executarDecisao(tenantId, { c, acao: 'pausar', motivo: 'pausada pelo dono' }); }

export function registrar() {
  domain.on('produto.indisponivel', ({ tenantId, ids }) => {
    if (!hired(tenantId, 'caio')) return;
    const afetadas = listCampaigns(tenantId).filter((c) => c.status === 'ativa' && c.produto_ids?.some((id) => ids.includes(id)));
    for (const c of afetadas) {
      const restantes = c.produto_ids.filter((id) => !ids.includes(id) && disponibilidade(getProduct(id), getSettings(tenantId)).ok);
      if (!restantes.length) { save({ ...c, status: 'pausada', pausada_por: 'produto indisponível', pausada_auto: true }); log(tenantId, 'caio', `Pausou "${c.nome}": o produto anunciado ficou indisponível`, { type: 'campanha', kind: 'acao', level: 'warning' }); }
      else { save({ ...c, produto_ids: restantes, removidos: [...(c.removidos || []), ...c.produto_ids.filter((id) => ids.includes(id))] }); log(tenantId, 'caio', `Tirou da campanha "${c.nome}" os produtos que ficaram indisponíveis`, { type: 'campanha', kind: 'acao' }); }
    }
  });
  domain.on('produto.disponivel', ({ tenantId, ids }) => {
    if (!hired(tenantId, 'caio')) return;
    for (const c of listCampaigns(tenantId).filter((x) => x.pausada_auto && x.produto_ids.some((id) => ids.includes(id)))) {
      createTask(tenantId, { responsavel: 'caio', solicitante: 'caio', tipo: 'sugestao', titulo: `Reativar "${c.nome}"? O produto voltou`, acao: { acao: 'ativar', params: { campanha_id: c.id } } });
    }
  });
}
