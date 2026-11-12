// Automações da floricultura: "quando acontecer X, se Y, faça Z".
// Toda execução passa pelas mesmas proteções, na ordem:
//   1. a automação está ligada e o agente responsável está contratado;
//   2. nunca repete a mesma mensagem para o mesmo alvo (chave de deduplicação);
//   3. não fala com quem está sendo atendido por uma pessoa da loja;
//   4. marketing só para quem deu consentimento, no máximo 1 por semana por contato;
//   5. mensagens de marketing respeitam o horário de silêncio (21h às 8h);
//   6. tudo é registrado, inclusive o que deixou de ser enviado e o motivo.
import { db } from './store.js';
import { active, getTenant } from './team.js';
import { log, domain } from './events.js';
import { createTask } from './tasks.js';
import { listInsumos } from './catalog.js';
import { getOrder, listOrders } from './orders.js';
import { normTel, getContato } from './crm.js';
import { enviarParaContato } from './agents/flora.js';
import { uid, now, localDate, localTime, addDays, diffDays, fmtDia } from './util.js';

export const MODELOS = {
  conversa_parada: {
    nome: 'Conversa parada sem pedido', agente: 'flora', tipo: 'transacional', gatilho: 'A cada 10 minutos',
    descricao: 'O cliente escolheu um produto e parou de responder. A Flora retoma uma vez, dentro da janela de 24 h do WhatsApp.',
    params: { horas: 2 }, mensagem: 'Oi{, primeiro_nome}! Vi que você estava escolhendo o {produto}. Posso te ajudar a finalizar? 🌷', padrao: true,
  },
  pagamento_pendente: {
    nome: 'Lembrete de pagamento pendente', agente: 'flora', tipo: 'transacional', gatilho: 'A cada 10 minutos',
    descricao: 'Pedido criado e ainda não pago. Reenvia o mesmo link (nunca cria outro pedido).',
    params: { horas: 3 }, mensagem: 'Oi{, primeiro_nome}! Seu pedido #{pedido} ainda está aguardando pagamento. O link é este: {link}', padrao: true,
  },
  pagamento_confirmado: {
    nome: 'Confirmação de pagamento', agente: 'flora', tipo: 'transacional', gatilho: 'Quando o sistema confirma o pagamento',
    descricao: 'Avisa o cliente assim que o pagamento é confirmado pelo sistema de pagamento.',
    params: {}, mensagem: 'Pagamento confirmado! 💐 Seu pedido #{pedido} já está na nossa fila de produção para {data}.', padrao: true,
  },
  saiu_para_entrega: {
    nome: 'Pedido saiu para entrega', agente: 'flora', tipo: 'transacional', gatilho: 'Quando o pedido muda para "saiu para entrega"',
    descricao: 'Avisa o comprador que as flores estão a caminho.',
    params: {}, mensagem: 'Seu pedido #{pedido} saiu para entrega! 🚚 Chega hoje em {janela}.', padrao: true,
  },
  pos_venda: {
    nome: 'Pós-venda e avaliação', agente: 'flora', tipo: 'transacional', gatilho: 'Horas depois da entrega',
    descricao: 'Pergunta se as flores chegaram bem e convida para avaliar.',
    params: { horas_apos_entrega: 20 }, mensagem: 'Oi{, primeiro_nome}! As flores chegaram bem? Se puder, conta pra gente como foi. Sua opinião ajuda muito! 🌷', padrao: true,
  },
  data_especial: {
    nome: 'Lembrete de data especial', agente: 'flora', tipo: 'marketing', gatilho: 'Todo dia às 10h',
    descricao: 'Antes do aniversário ou da ocasião que o cliente comemorou no ano passado. Só para quem autorizou mensagens.',
    params: { dias_antes: 5 }, mensagem: 'Oi{, primeiro_nome}! No ano passado você presenteou com flores no dia {data_ocasiao}{ (ocasiao)}. Quer que eu separe algo especial de novo? (Responda SAIR para não receber lembretes.)', padrao: true,
  },
  reativacao: {
    nome: 'Reativar cliente inativo', agente: 'flora', tipo: 'marketing', gatilho: 'Todo dia às 10h',
    descricao: 'Clientes sem comprar há muito tempo. Só para quem autorizou mensagens.',
    params: { dias_sem_compra: 90 }, mensagem: 'Oi{, primeiro_nome}! Faz tempo que não te vemos por aqui. Temos novidades lindas esta semana. Quer que eu te mostre? 🌷 (Responda SAIR para não receber.)', padrao: false,
  },
  estoque_baixo: {
    nome: 'Insumo acabando', agente: 'alex', tipo: 'interno', gatilho: 'A cada 10 minutos',
    descricao: 'Quando uma flor ou material fica abaixo do mínimo, o Alex abre uma tarefa de compra.',
    params: { minimo_padrao: 5 }, mensagem: '', padrao: true,
  },
  resumo_dono: {
    nome: 'Resumo diário para o dono', agente: 'alex', tipo: 'interno', gatilho: 'No horário do resumo do Alex',
    descricao: 'O Alex manda o resumo do dia no WhatsApp do dono (configure o número em Configurar → Alex).',
    params: {}, mensagem: '', padrao: true,
  },
  avaliacao_positiva: {
    nome: 'Avaliação boa vira conteúdo', agente: 'mari', tipo: 'interno', gatilho: 'Quando chega uma avaliação 4 ou 5 estrelas',
    descricao: 'A Mari recebe uma tarefa para transformar a avaliação em post de depoimento.',
    params: { nota_minima: 4 }, mensagem: '', padrao: true,
  },
};

// ---------------- configuração por loja ----------------
const cfgId = (t, k) => `${t}:${k}`;
export function getAutomacao(tenantId, k) {
  const m = MODELOS[k]; if (!m) return null;
  const c = db().get('automacoes', cfgId(tenantId, k));
  return { id: k, ...m, ativo: c?.ativo ?? m.padrao, params: { ...m.params, ...(c?.params || {}) }, mensagem: c?.mensagem ?? m.mensagem };
}
export const listarAutomacoes = (tenantId) => Object.keys(MODELOS).map((k) => ({ ...getAutomacao(tenantId, k), stats: estatisticas(tenantId, k), agente_ativo: active(tenantId, MODELOS[k].agente) }));
export function salvarAutomacao(tenantId, k, { ativo, params, mensagem }) {
  if (!MODELOS[k]) throw Object.assign(new Error('Automação não encontrada'), { status: 404 });
  const atual = db().get('automacoes', cfgId(tenantId, k)) || { id: cfgId(tenantId, k), tenant_id: tenantId };
  db().put('automacoes', { ...atual, ...(ativo !== undefined ? { ativo: !!ativo } : {}), ...(params ? { params: { ...(atual.params || {}), ...params } } : {}), ...(mensagem !== undefined ? { mensagem } : {}) });
  log(tenantId, MODELOS[k].agente, `Automação "${MODELOS[k].nome}" ${ativo === false ? 'desligada' : 'atualizada'} pelo dono`, { type: 'automacao' });
  return getAutomacao(tenantId, k);
}

function estatisticas(tenantId, k) {
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const ex = db().list('automacao_execucoes', tenantId, (e) => e.modelo === k && e.created_at >= desde);
  return { enviadas_30d: ex.filter((e) => e.status === 'enviado').length, puladas_30d: ex.filter((e) => e.status === 'pulado').length, ultima: ex.map((e) => e.created_at).sort().pop() || null };
}
export const listarExecucoes = (tenantId, limit = 100) => db().list('automacao_execucoes', tenantId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit);

// ---------------- texto ----------------
export function preencher(modelo, v) {
  return modelo
    .replace(/\{([^{}\w]*)(primeiro_nome|ocasiao)([^{}\w]*)\}/g, (_, a, k, b) => (k === 'primeiro_nome' ? (v.primeiro_nome ? `${a}${v.primeiro_nome}${b}` : '') : v.ocasiao ? `${a}${v.ocasiao}${b}` : ''))
    .replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
}

// ---------------- execução protegida ----------------
const silencio = (agora) => { const h = localTime(agora); return h >= '21:00' || h < '08:00'; };

async function executar(tenantId, k, { chave, contato, nome, vars = {}, canal = 'whatsapp', agora = new Date() }) {
  const a = getAutomacao(tenantId, k);
  const reg = (status, motivo, texto = null) => db().put('automacao_execucoes', { id: uid('aut_'), tenant_id: tenantId, modelo: k, nome: a.nome, chave, contato, status, motivo, texto });
  if (!a.ativo || !active(tenantId, a.agente)) return null;
  const dedupId = `${tenantId}:${k}:${chave}`;
  if (db().get('automacao_dedup', dedupId)) return null; // já tratado antes: silencioso
  const conv = contato ? db().list('conversations', tenantId, (c) => normTel(c.contato) === normTel(contato))[0] : null;
  const marcar = () => db().put('automacao_dedup', { id: dedupId, tenant_id: tenantId, em: now() });
  if (conv?.status === 'humano') { marcar(); return reg('pulado', 'uma pessoa da loja está atendendo'); }
  if (a.tipo === 'marketing') {
    const cli = getContato(tenantId, contato);
    if (!cli?.optin_marketing) { marcar(); return reg('pulado', 'sem consentimento para mensagens'); }
    if (silencio(agora)) return null; // tenta de novo na próxima rodada
    const recente = db().list('automacao_execucoes', tenantId, (e) => e.contato === contato && e.status === 'enviado' && MODELOS[e.modelo]?.tipo === 'marketing' && e.created_at >= new Date(agora - 7 * 864e5).toISOString());
    if (recente.length) { marcar(); return reg('pulado', 'já recebeu uma mensagem de marketing nesta semana'); }
  }
  const texto = preencher(a.mensagem, { loja: getTenant(tenantId).name, ...vars, primeiro_nome: (nome || '').split(' ')[0] || '' });
  marcar();
  await enviarParaContato(tenantId, { canal, contato, nome, texto });
  log(tenantId, a.agente, `Automação "${a.nome}": mensagem enviada para ${nome || contato}`, { type: 'automacao', kind: 'acao' });
  return reg('enviado', null, texto);
}

/** Resumo do Alex no WhatsApp do dono (uma vez por dia). */
export async function enviarResumoDono(tenantId, texto, numero) {
  const a = getAutomacao(tenantId, 'resumo_dono');
  if (!a.ativo || !numero) return null;
  const dedupId = `${tenantId}:resumo_dono:${localDate()}`;
  if (db().get('automacao_dedup', dedupId)) return null;
  db().put('automacao_dedup', { id: dedupId, tenant_id: tenantId, em: now() });
  await enviarParaContato(tenantId, { canal: 'whatsapp', contato: numero, nome: 'Dono', texto });
  return db().put('automacao_execucoes', { id: uid('aut_'), tenant_id: tenantId, modelo: 'resumo_dono', nome: a.nome, chave: localDate(), contato: numero, status: 'enviado', motivo: null, texto });
}

/** Varreduras periódicas (chamadas pelo agendador de cada loja). */
export async function executarAutomacoes(tenantId, agora = new Date()) {
  const feitos = [];
  const hoje = localDate(agora);
  // 1. conversa parada
  { const a = getAutomacao(tenantId, 'conversa_parada'); const limite = new Date(agora - a.params.horas * 3600e3).toISOString(); const janela = new Date(agora - 23 * 3600e3).toISOString();
    for (const c of db().list('conversations', tenantId, (x) => x.ultima_cliente_em && x.ultima_cliente_em <= limite && x.ultima_cliente_em >= janela && x.estado?.itens?.length && !x.estado.pedido_id)) {
      feitos.push(await executar(tenantId, 'conversa_parada', { chave: `${c.id}:${c.ultima_cliente_em}`, contato: c.contato, nome: c.nome, canal: c.canal === 'simulador' ? 'simulador' : c.canal, vars: { produto: c.estado.itens[0].nome }, agora }));
    } }
  // 2. pagamento pendente
  { const a = getAutomacao(tenantId, 'pagamento_pendente'); const limite = new Date(agora - a.params.horas * 3600e3).toISOString();
    for (const o of listOrders(tenantId, (x) => x.status === 'aguardando_pagamento' && x.created_at <= limite && x.contato)) {
      feitos.push(await executar(tenantId, 'pagamento_pendente', { chave: o.id, contato: o.contato, nome: o.comprador, canal: o.canal === 'simulador' ? 'simulador' : 'whatsapp', vars: { pedido: o.numero, link: o.pagamento.link }, agora }));
    } }
  // 3. pós-venda
  { const a = getAutomacao(tenantId, 'pos_venda'); const limite = new Date(agora - a.params.horas_apos_entrega * 3600e3).toISOString();
    for (const o of listOrders(tenantId, (x) => x.status === 'entregue' && (x.entregue_em || x.updated_at) <= limite && x.contato)) {
      feitos.push(await executar(tenantId, 'pos_venda', { chave: o.id, contato: o.contato, nome: o.comprador, vars: { pedido: o.numero }, agora }));
    } }
  // 4. datas especiais e reativação (marketing, só com consentimento)
  { const a = getAutomacao(tenantId, 'data_especial'); const alvo = addDays(hoje, a.params.dias_antes);
    for (const c of db().list('customers', tenantId, (x) => x.data_ocasiao && x.data_ocasiao < hoje && x.data_ocasiao.slice(5) === alvo.slice(5))) {
      feitos.push(await executar(tenantId, 'data_especial', { chave: `${c.contato}:${alvo}`, contato: c.contato, nome: c.nome, vars: { data_ocasiao: fmtDia(c.data_ocasiao), ocasiao: c.ocasiao }, agora }));
    } }
  { const a = getAutomacao(tenantId, 'reativacao');
    for (const c of db().list('customers', tenantId, (x) => x.ultima_compra && diffDays(hoje, x.ultima_compra) >= a.params.dias_sem_compra)) {
      feitos.push(await executar(tenantId, 'reativacao', { chave: `${c.contato}:${c.ultima_compra}`, contato: c.contato, nome: c.nome, agora }));
    } }
  // 5. insumo acabando → tarefa do Alex
  { const a = getAutomacao(tenantId, 'estoque_baixo');
    if (a.ativo && active(tenantId, 'alex')) for (const i of listInsumos(tenantId).filter((x) => x.estoque != null && x.estoque <= (x.estoque_minimo ?? a.params.minimo_padrao) && x.tipo !== 'embalagem')) {
      const dedupId = `${tenantId}:estoque_baixo:${i.id}:${hoje}`;
      if (db().get('automacao_dedup', dedupId)) continue;
      db().put('automacao_dedup', { id: dedupId, tenant_id: tenantId, em: now() });
      createTask(tenantId, { responsavel: 'alex', solicitante: 'alex', tipo: 'sugestao', titulo: `Comprar ${i.nome}: restam ${i.estoque} ${i.unidade}`, detalhes: 'Veja a quantidade sugerida em Loja → Sugestão de compras.' });
      db().put('automacao_execucoes', { id: uid('aut_'), tenant_id: tenantId, modelo: 'estoque_baixo', nome: a.nome, chave: i.id, status: 'enviado', motivo: null, texto: `Tarefa de compra: ${i.nome}` });
    } }
  return feitos.filter(Boolean);
}

/** Automações disparadas por eventos (pagamento confirmado, status do pedido, avaliação). */
let registrado = false;
export function registrarAutomacoes() {
  if (registrado) return; registrado = true;
  domain.on('pedido.pago', ({ tenantId, order_id }) => {
    const o = getOrder(order_id); if (!o?.contato) return;
    executar(tenantId, 'pagamento_confirmado', { chave: o.id, contato: o.contato, nome: o.comprador, canal: o.canal === 'simulador' ? 'simulador' : 'whatsapp', vars: { pedido: o.numero, data: fmtDia(o.data || localDate()) } }).catch(() => {});
  });
  domain.on('pedido.status', ({ tenantId, order_id, status }) => {
    if (status !== 'saiu_para_entrega') return;
    const o = getOrder(order_id); if (!o?.contato) return;
    executar(tenantId, 'saiu_para_entrega', { chave: o.id, contato: o.contato, nome: o.comprador, vars: { pedido: o.numero, janela: o.janela || 'algumas horas' } }).catch(() => {});
  });
  domain.on('avaliacao.recebida', ({ tenantId, nota, comentario, cliente }) => {
    const a = getAutomacao(tenantId, 'avaliacao_positiva');
    if (!a.ativo || !active(tenantId, 'mari') || Number(nota) < a.params.nota_minima) return;
    createTask(tenantId, { responsavel: 'mari', solicitante: 'mari', tipo: 'pedido', titulo: `Post de depoimento${cliente ? ` de ${cliente}` : ''}: "${String(comentario || '').slice(0, 80)}"` });
    db().put('automacao_execucoes', { id: uid('aut_'), tenant_id: tenantId, modelo: 'avaliacao_positiva', nome: a.nome, chave: uid(), status: 'enviado', motivo: null, texto: 'Tarefa criada para a Mari' });
  });
}

