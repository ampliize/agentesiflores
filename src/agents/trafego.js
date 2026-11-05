// Agente GESTOR DE TRÁFEGO — analisa campanhas, pausa o que não performa, escala o que vende
// e propõe/cria campanhas (inclusive sazonais). As regras de corte são determinísticas
// (seguras e auditáveis); a IA entra na análise estratégica e na criação de campanhas.
import { all, run, uid, now } from '../db.js';
import { getAgentConfig, getTenant } from '../lib/tenants.js';
import { logActivity, setAgentStatus } from '../lib/events.js';
import { aiEnabled, structured } from '../lib/llm.js';
import { MetaAds, cacheCampaigns } from '../integrations/meta.js';
import { upcomingDates } from '../lib/calendar.js';
import { createTask } from '../lib/tasks.js';

const fmt = (n, d = 2) => Number(n || 0).toFixed(d).replace('.', ',');

/** Aplica as regras do dono e retorna as decisões (sem executar). */
export function evaluateRules(campaigns, cfg) {
  const r = cfg.regras;
  const decisions = [];
  for (const c of campaigns.filter((x) => x.status === 'ativa')) {
    if (c.gasto >= r.pausar_sem_conversao_apos_gasto && !c.conversoes) {
      decisions.push({ acao: 'pausar', campanha: c, motivo: `Gastou R$ ${fmt(c.gasto)} sem nenhuma conversão (limite R$ ${r.pausar_sem_conversao_apos_gasto})` });
    } else if (c.impressoes > 2000 && c.ctr < r.pausar_ctr_abaixo) {
      decisions.push({ acao: 'pausar', campanha: c, motivo: `CTR ${fmt(c.ctr)}% abaixo do mínimo de ${r.pausar_ctr_abaixo}%` });
    } else if (c.cpa && c.cpa > cfg.cpa_maximo * 1.3) {
      decisions.push({ acao: 'pausar', campanha: c, motivo: `CPA R$ ${fmt(c.cpa)} acima do máximo de R$ ${fmt(cfg.cpa_maximo)}` });
    } else if (c.roas >= r.escalar_roas_acima) {
      const novo = Math.round(c.orcamento_diario * (1 + r.percentual_escala / 100));
      decisions.push({ acao: 'escalar', campanha: c, novo_orcamento: novo, motivo: `ROAS ${fmt(c.roas)} acima de ${r.escalar_roas_acima}: orçamento R$ ${c.orcamento_diario} → R$ ${novo}` });
    } else if (c.roas && c.roas < cfg.roas_minimo) {
      decisions.push({ acao: 'alerta', campanha: c, motivo: `ROAS ${fmt(c.roas)} abaixo da meta de ${cfg.roas_minimo}; criativo será renovado` });
    }
  }
  return decisions;
}

const STRATEGY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['diagnostico', 'recomendacoes', 'novas_campanhas', 'pedidos_de_criativo'],
  properties: {
    diagnostico: { type: 'string' },
    recomendacoes: { type: 'array', items: { type: 'string' } },
    novas_campanhas: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['nome', 'objetivo', 'orcamento_diario', 'publico', 'mensagem', 'justificativa'], properties: { nome: { type: 'string' }, objetivo: { type: 'string', enum: ['OUTCOME_SALES', 'OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS'] }, orcamento_diario: { type: 'number' }, publico: { type: 'string' }, mensagem: { type: 'string' }, justificativa: { type: 'string' } } },
    },
    pedidos_de_criativo: { type: 'array', items: { type: 'string' }, description: 'Criativos que a Social Media deve produzir' },
  },
};

export async function analyze(tenantId, { reason = 'análise programada' } = {}) {
  const tenant = getTenant(tenantId);
  const cfg = getAgentConfig(tenantId, 'trafego');
  if (!cfg.enabled) return null;
  setAgentStatus(tenantId, 'trafego', 'trabalhando', 'Analisando campanhas');
  try {
    const ads = new MetaAds(tenant);
    const campaigns = await ads.campaignsWithInsights();
    if (!ads.demo) cacheCampaigns(tenantId, campaigns);

    // 1) regras automáticas
    const decisions = evaluateRules(campaigns, cfg);
    for (const d of decisions) {
      if (d.acao === 'alerta') {
        logActivity(tenantId, 'trafego', 'alerta_campanha', `${d.campanha.name}: ${d.motivo}`, { campanha: d.campanha.external_id }, 'warning');
        createTask(tenantId, { agent: 'social', title: `Novo criativo para "${d.campanha.name}" (ROAS baixo)`, created_by: 'trafego', priority: 'alta' });
        continue;
      }
      if (!cfg.acao_automatica) {
        createTask(tenantId, { agent: 'trafego', title: `Aprovar: ${d.acao} "${d.campanha.name}" — ${d.motivo}`, created_by: 'trafego', status: 'review', priority: 'alta', data: { decision: { acao: d.acao, external_id: d.campanha.external_id, novo_orcamento: d.novo_orcamento } } });
        logActivity(tenantId, 'trafego', 'sugestao', `Sugeriu ${d.acao} "${d.campanha.name}" (aguardando aprovação)`, {}, 'info');
        continue;
      }
      await executeDecision(tenant, ads, d);
    }

    // 2) estratégia + novas campanhas
    const datas = upcomingDates(40).filter((d) => d.peso >= 3);
    let estrategia;
    if (aiEnabled()) {
      estrategia = await structured({
        system: `Você é ${cfg.nome_exibicao}, gestor de tráfego pago sênior especializado em floriculturas locais (Meta Ads). Seja direto, baseado em números.`,
        prompt: `Floricultura: ${tenant.name}${cfg.cidade ? ` (${cfg.cidade}, raio de entrega ${cfg.raio_entrega_km} km)` : ''}.
Objetivo: ${cfg.objetivo}. Verba diária: R$ ${cfg.verba_diaria} (mensal R$ ${cfg.verba_mensal}). CPA máximo R$ ${cfg.cpa_maximo}. ROAS mínimo ${cfg.roas_minimo}.
Público base: ${cfg.publico}.
Campanhas (últimos 7 dias): ${JSON.stringify(campaigns.map((c) => ({ nome: c.name, status: c.status, orcamento_diario: c.orcamento_diario, gasto: c.gasto, ctr: c.ctr, conversoes: c.conversoes, roas: Number(c.roas?.toFixed?.(2) ?? c.roas), cpa: c.cpa })))}
Ações automáticas já tomadas: ${JSON.stringify(decisions.map((d) => `${d.acao} ${d.campanha.name}: ${d.motivo}`))}
Datas comemorativas próximas: ${JSON.stringify(datas)}
${cfg.criar_campanhas_sazonais ? 'Proponha campanhas sazonais se houver data importante em até 40 dias (comece 10-15 dias antes).' : 'Não proponha campanhas sazonais.'}
Respeite a verba diária total. ${cfg.instrucoes || ''}`,
        schema: STRATEGY_SCHEMA,
        effort: 'medium',
      });
    } else {
      estrategia = demoStrategy(campaigns, decisions, datas, cfg);
    }

    const ativas = all("SELECT * FROM campaigns WHERE tenant_id = ? AND status = 'ativa'", tenantId);
    for (const nc of estrategia.novas_campanhas.slice(0, 2)) {
      if (all('SELECT id FROM campaigns WHERE tenant_id = ? AND name = ?', tenantId, nc.nome).length) continue;
      const gastoAtual = ativas.reduce((s, c) => s + (c.orcamento_diario || 0), 0);
      const cabe = gastoAtual + nc.orcamento_diario <= cfg.verba_diaria * 1.1;
      if (cfg.acao_automatica && cabe) {
        await ads.createCampaign({ nome: nc.nome, objetivo: nc.objetivo, orcamento_diario: nc.orcamento_diario, ativa: false });
        logActivity(tenantId, 'trafego', 'campanha_criada', `Criou campanha "${nc.nome}" (R$ ${nc.orcamento_diario}/dia, pausada até o criativo ficar pronto)`, nc, 'success');
        createTask(tenantId, { agent: 'social', title: `Criativos para campanha "${nc.nome}": ${nc.mensagem}`, created_by: 'trafego', priority: 'alta' });
      } else {
        createTask(tenantId, { agent: 'trafego', title: `Aprovar nova campanha "${nc.nome}" (R$ ${nc.orcamento_diario}/dia)`, created_by: 'trafego', status: 'review', data: { proposta: nc } });
      }
    }
    for (const pedido of estrategia.pedidos_de_criativo.slice(0, 3)) {
      createTask(tenantId, { agent: 'social', title: pedido, created_by: 'trafego' });
    }

    const report = { campanhas: campaigns.length, decisoes: decisions.map((d) => ({ acao: d.acao, campanha: d.campanha.name, motivo: d.motivo })), ...estrategia, demo: ads.demo };
    run('INSERT INTO reports (id, tenant_id, agent, kind, data, created_at) VALUES (?,?,?,?,?,?)', uid('rep_'), tenantId, 'trafego', 'analise', JSON.stringify(report), now());
    logActivity(tenantId, 'trafego', 'analise', `Análise concluída (${reason}): ${estrategia.diagnostico.slice(0, 140)}`, {}, 'success');
    return report;
  } finally {
    setAgentStatus(tenantId, 'trafego', 'online', '');
  }
}

export async function executeDecision(tenant, ads, d) {
  ads ||= new MetaAds(tenant);
  const extId = d.campanha?.external_id || d.external_id;
  const name = d.campanha?.name || extId;
  if (d.acao === 'pausar') {
    await ads.pause(extId);
    logActivity(tenant.id, 'trafego', 'campanha_pausada', `Pausou "${name}": ${d.motivo || 'aprovado pelo dono'}`, { campanha: extId }, 'warning');
  } else if (d.acao === 'escalar') {
    await ads.setDailyBudget(extId, d.novo_orcamento);
    logActivity(tenant.id, 'trafego', 'campanha_escalada', `Escalou "${name}": ${d.motivo || `novo orçamento R$ ${d.novo_orcamento}`}`, { campanha: extId }, 'success');
  }
}

function demoStrategy(campaigns, decisions, datas, cfg) {
  const ativas = campaigns.filter((c) => c.status === 'ativa');
  const gasto = campaigns.reduce((s, c) => s + c.gasto, 0); const receita = campaigns.reduce((s, c) => s + c.receita, 0);
  const roas = gasto ? receita / gasto : 0;
  const prox = datas[0];
  return {
    diagnostico: `ROAS geral de ${fmt(roas)} em 7 dias (meta ${cfg.roas_minimo}). ${decisions.filter((d) => d.acao === 'pausar').length} campanha(s) cortada(s) por baixo desempenho; ${ativas.length} seguem ativas.`,
    recomendacoes: [
      'Concentrar verba nas campanhas de conversão com ROAS acima da meta.',
      'Testar 2 novos criativos em vídeo curto (Reels) mostrando a montagem do buquê.',
      `Segmentar por raio de ${cfg.raio_entrega_km} km da loja para não pagar por cliques fora da área de entrega.`,
    ],
    novas_campanhas: prox && cfg.criar_campanhas_sazonais ? [{ nome: `${prox.nome} ${new Date().getFullYear()} - Conversão`, objetivo: 'OUTCOME_SALES', orcamento_diario: Math.round(cfg.verba_diaria * 0.3), publico: cfg.publico, mensagem: `Antecipe seu presente de ${prox.nome} com entrega garantida`, justificativa: `${prox.nome} em ${prox.dias} dias — data de alto volume para floriculturas.` }] : [],
    pedidos_de_criativo: decisions.some((d) => d.acao === 'pausar') ? ['Criativo novo para substituir campanha pausada: foco em entrega no mesmo dia'] : [],
  };
}
