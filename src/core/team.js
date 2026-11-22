// A Equipe dos Sonhos: definição dos 5 agentes, configuração padrão e contratação.
import { db } from './store.js';
import { mergeDeep, now } from './util.js';

export const AGENTS = {
  alex: { nome: 'Alex', area: 'Gestão', cargo: 'Gerente da floricultura', cor: '#4f46e5', avatar: 'A',
    resumo: 'Executa alterações na loja por conversa, acompanha os números e organiza as prioridades.' },
  flora: { nome: 'Flora', area: 'Atendimento e vendas', cargo: 'Atendente no WhatsApp e no chat da loja', cor: '#0f8a5f', avatar: 'F',
    resumo: 'Atende 24 h, recomenda produtos, monta o pedido e envia o link de pagamento.' },
  mari: { nome: 'Mari', area: 'Conteúdo', cargo: 'Conteúdo e Instagram', cor: '#d6336c', avatar: 'M',
    resumo: 'Transforma as fotos da loja em posts, carrosséis e stories com constância.' },
  caio: { nome: 'Caio', area: 'Anúncios', cargo: 'Tráfego pago (Meta e Google)', cor: '#1c6dd0', avatar: 'C',
    resumo: 'Cria e acompanha anúncios dentro do teto de gasto definido pela loja.' },
  sol: { nome: 'Sol', area: 'Finanças', cargo: 'Custos, preços e margem', cor: '#c77700', avatar: 'S',
    resumo: 'Mostra quanto cada venda deixa, simula preços e avalia descontos.' },
};
export const AGENT_KEYS = Object.keys(AGENTS);
// Plano atual da oferta. A Flora fica fora (o iFlores já tem um agente de atendimento). O código dela permanece para uso futuro.
export const PLANO_PADRAO = AGENT_KEYS.filter((k) => k !== 'flora');

export const DEFAULTS = {
  alex: {
    enabled: true,
    metas: { faturamento_mensal: 30000, pedidos_mes: 220, ticket_medio: 140, conversao_site_pct: 2.5, margem_contribuicao_pct: 45 },
    resumo_diario: { ativo: true, horario: '19:00', whatsapp_dono: '' },
    relatorio_semanal: { ativo: true, dia: 'seg' },
    permissoes: { produtos: true, estoque: true, categorias: true, horarios: true, datas: true, pedidos: true, data_comemorativa: true, fretes: true },
    confirmar_lote_acima: 25,
    compras: { dias_cobertura: 4, perda_padrao_pct: 12, fator_data_comemorativa: 2.5 },
    instrucoes: '',
  },
  flora: {
    enabled: true,
    canais: { whatsapp: true, chat_loja: true },
    tom: 'acolhedora, clara e objetiva; poucos emojis',
    saudacao: 'Olá! Aqui é a Flora, da {loja}. Posso te ajudar a escolher as flores? 🌷',
    fazer_upsell: true,
    desconto_maximo_pct: 0,
    transferir_quando: 'reclamação, pedido de desconto, eventos e casamentos, cliente pedir uma pessoa, problema com pedido já pago',
    recuperar_abandonos: true,
    horas_para_recuperar: 2,
    recompra: { ativa: true, dias_antes: 5 },
    instrucoes: '',
  },
  mari: {
    enabled: true,
    feed_semana: 3, stories_dia: 2, carrosseis_semana: 1,
    dias: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'],
    horarios_feed: ['11:00', '18:30'], horarios_stories: ['09:00', '12:30', '17:30'],
    aprovacao: 'lote', // individual | lote | automatica
    tom: 'delicado e afetivo, frases curtas',
    cores_marca: ['#b8325e', '#24493d', '#fbf6f1'],
    hashtags: ['#floricultura', '#flores', '#presente'],
    repetir_foto_apos_dias: 14,
    instrucoes: '',
  },
  caio: {
    enabled: true,
    plataformas: { meta: true, google: true },
    teto_diario: 60, teto_mensal: 1500,
    autonomia: 'ajustar_dentro_do_teto', // sugerir | ajustar_dentro_do_teto
    cpa_maximo: 35, roas_minimo: 3,
    regras: { pausar_sem_venda_apos_gasto: 60, pausar_ctr_abaixo: 0.7, escalar_roas_acima: 5, escalar_pct: 20 },
    margem_minima_para_escalar_pct: 35,
    regiao: { cidade: 'São Paulo', raio_km: 10 },
    instrucoes: '',
  },
  sol: {
    enabled: true,
    custos_fixos: [
      { nome: 'Aluguel', valor: 3200 }, { nome: 'Energia', valor: 420 }, { nome: 'Água', valor: 160 },
      { nome: 'Salários e encargos', valor: 5800 }, { nome: 'Pró-labore', valor: 4000 }, { nome: 'Sistema e internet', valor: 380 },
    ],
    variaveis: { taxa_pagamento_pct: 3.5, impostos_pct: 6, comissao_pct: 0, outros_pct: 0 },
    rateio: { base: 'faturamento', faturamento_mensal_esperado: 30000, pedidos_mensais_esperados: 210 },
    margem_alvo_pct: 15,
  },
};

const cfgId = (t, a) => `${t}:${a}`;

export async function getConfig(tenantId, agent) {
  const doc = await db().get('configs', cfgId(tenantId, agent));
  const { id, tenant_id, agent: _a, created_at, updated_at, ...cfg } = doc || {};
  return mergeDeep(DEFAULTS[agent], cfg);
}

export async function saveConfig(tenantId, agent, patch) {
  const current = await getConfig(tenantId, agent);
  const merged = mergeDeep(current, patch || {});
  await db().put('configs', { id: cfgId(tenantId, agent), tenant_id: tenantId, agent, ...merged });
  return getConfig(tenantId, agent);
}

// ---------- contratação (individual ou combo) ----------
export async function getTenant(tenantId) { return db().get('tenants', tenantId); }

export async function hired(tenantId, agent) { return !!(await getTenant(tenantId))?.plano?.agentes?.[agent]; }
/** Agente contratado e ligado. */
export async function active(tenantId, agent) { return (await hired(tenantId, agent)) && (await getConfig(tenantId, agent)).enabled; }

export async function setHired(tenantId, agent, value) {
  const t = await getTenant(tenantId);
  const agentes = { ...(t.plano?.agentes || {}), [agent]: !!value };
  await db().put('tenants', { ...t, plano: { ...(t.plano || {}), agentes, atualizado_em: now() } });
  return agentes;
}
