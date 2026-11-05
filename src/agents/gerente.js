// Agente GERENTE — fica "no pé" dos outros agentes: mede metas, revisa artes antes de
// publicar, audita atendimentos, cobra entregas (cria tarefas) e reporta ao dono.
import { get, all, run, uid, now } from '../db.js';
import { getAgentConfig, getTenant } from '../lib/tenants.js';
import { logActivity, setAgentStatus } from '../lib/events.js';
import { aiEnabled, structured } from '../lib/llm.js';
import { IFloresClient } from '../integrations/iflores.js';
import { sendWhatsApp } from '../integrations/whatsapp.js';
import { createTask, listTasks } from '../lib/tasks.js';
import { conversationStats, listMessages } from './atendente.js';
import { listPosts, updatePost, revisePost, planWeek } from './social.js';

const brl = (v) => `R$ ${Math.round(v || 0).toLocaleString('pt-BR')}`;
const pct = (v, meta) => (meta ? Math.min(999, Math.round((v / meta) * 100)) : 0);

/** KPIs consolidados vs metas — alimenta o painel e o relatório. */
export async function computeKpis(tenantId) {
  const tenant = getTenant(tenantId);
  const metas = getAgentConfig(tenantId, 'gerente').metas;
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const elapsed = Math.max(1, d.getDate());
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();

  let vendas = { faturamento: 0, pedidos: 0, ticket_medio: 0 };
  try { vendas = await new IFloresClient(tenant).salesSummary({ from: monthStart.toISOString().slice(0, 10), to: d.toISOString().slice(0, 10) }); } catch { /* sem dados */ }
  const atend = conversationStats(tenantId, weekAgo);
  const posts = all("SELECT * FROM posts WHERE tenant_id = ? AND format = 'feed' AND status IN ('publicado','agendado') AND COALESCE(scheduled_at, created_at) >= ?", tenantId, weekAgo);
  const camps = all('SELECT * FROM campaigns WHERE tenant_id = ?', tenantId);
  const gasto = camps.reduce((s, c) => s + (c.gasto || 0), 0); const receita = camps.reduce((s, c) => s + (c.receita || 0), 0);
  const roas = gasto ? receita / gasto : 0;
  const projecao = (vendas.faturamento / elapsed) * daysInMonth;

  const items = [
    { chave: 'faturamento_mensal', label: 'Faturamento do mês', valor: vendas.faturamento, meta: metas.faturamento_mensal, fmt: 'brl', projecao, progresso: pct(projecao, metas.faturamento_mensal) },
    { chave: 'pedidos_mes', label: 'Pedidos no mês', valor: vendas.pedidos, meta: metas.pedidos_mes, fmt: 'int', progresso: pct((vendas.pedidos / elapsed) * daysInMonth, metas.pedidos_mes) },
    { chave: 'ticket_medio', label: 'Ticket médio', valor: vendas.ticket_medio, meta: metas.ticket_medio, fmt: 'brl', progresso: pct(vendas.ticket_medio, metas.ticket_medio) },
    { chave: 'roas_minimo', label: 'ROAS (7 dias)', valor: Math.round(roas * 100) / 100, meta: metas.roas_minimo, fmt: 'x', progresso: pct(roas, metas.roas_minimo), agente: 'trafego' },
    { chave: 'tempo_resposta_seg', label: 'Tempo médio de resposta', valor: atend.tempo_medio_resposta_seg, meta: metas.tempo_resposta_seg, fmt: 'seg', progresso: atend.tempo_medio_resposta_seg ? pct(metas.tempo_resposta_seg, atend.tempo_medio_resposta_seg) : 100, agente: 'atendente', menor_melhor: true },
    { chave: 'taxa_conversao_atendimento', label: 'Conversão no WhatsApp', valor: atend.taxa_conversao, meta: metas.taxa_conversao_atendimento, fmt: '%', progresso: pct(atend.taxa_conversao, metas.taxa_conversao_atendimento), agente: 'atendente' },
    { chave: 'posts_semana', label: 'Posts no feed (7 dias)', valor: posts.length, meta: metas.posts_semana, fmt: 'int', progresso: pct(posts.length, metas.posts_semana), agente: 'social' },
  ];
  return { items, vendas, atendimento: atend, trafego: { gasto, receita, roas, campanhas_ativas: camps.filter((c) => c.status === 'ativa').length }, demo: !!vendas.demo };
}

/** Nota de 0-100 por agente, usada nos cards da equipe. */
export function agentScores(kpis) {
  const by = (agent) => kpis.items.filter((i) => i.agente === agent).map((i) => Math.min(100, i.progresso));
  const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
  const geral = avg(kpis.items.slice(0, 3).map((i) => Math.min(100, i.progresso)));
  return { gerente: geral, trafego: avg(by('trafego')), social: avg(by('social')), atendente: avg(by('atendente')) };
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['aprovado', 'nota', 'feedback'],
  properties: { aprovado: { type: 'boolean' }, nota: { type: 'integer', description: '0 a 10' }, feedback: { type: 'string' } },
};

async function reviewPosts(tenantId, cfg) {
  const tenant = getTenant(tenantId);
  const social = getAgentConfig(tenantId, 'social');
  const pending = listPosts(tenantId, 'revisao_gerente').slice(0, 10);
  const minimo = { baixa: 5, media: 7, alta: 8 }[cfg.exigencia] || 7;
  for (const post of pending) {
    let r;
    if (aiEnabled()) {
      r = await structured({
        system: `Você é ${cfg.nome_exibicao}, gerente de marketing exigente de uma floricultura. Avalie peças antes de irem ao ar: clareza, gancho, ortografia, coerência com a marca (tom: ${social.tom}), CTA e se vende.`,
        prompt: `Loja: ${tenant.name}. Nível de exigência: ${cfg.exigencia} (aprovar só com nota >= ${minimo}).\nPeça: ${JSON.stringify({ formato: post.formato, tema: post.tema, titulo_arte: post.titulo_arte, subtitulo_arte: post.subtitulo_arte, cta: post.cta, legenda: post.legenda, hashtags: post.hashtags, produto: post.produto })}\nJá revisada ${(post.revisoes || []).length} vez(es).`,
        schema: REVIEW_SCHEMA, effort: 'low',
      });
    } else {
      const ok = (post.legenda || '').length > 20 && post.cta;
      r = { aprovado: !!ok, nota: ok ? 8 : 5, feedback: ok ? 'Peça clara e com CTA.' : 'Legenda curta demais; reforce a chamada para o WhatsApp.' };
    }
    const after = social.publicacao_automatica ? 'agendado' : 'aguardando_aprovacao';
    if (r.aprovado && r.nota >= minimo) {
      updatePost(post.id, { revisao_gerente: r }, after);
      logActivity(tenantId, 'gerente', 'post_aprovado', `Aprovou "${post.titulo_arte}" (nota ${r.nota})`, { post_id: post.id });
    } else if ((post.revisoes || []).length >= 2) {
      updatePost(post.id, { revisao_gerente: r }, 'aguardando_aprovacao');
      logActivity(tenantId, 'gerente', 'post_escalado', `"${post.titulo_arte}" não atingiu o padrão após 2 revisões — enviado ao dono`, { post_id: post.id }, 'warning');
    } else {
      logActivity(tenantId, 'gerente', 'post_reprovado', `Pediu ajustes em "${post.titulo_arte}" (nota ${r.nota}): ${r.feedback}`, { post_id: post.id }, 'warning');
      await revisePost(tenantId, post.id, r.feedback, 'gerente');
    }
  }
  return pending.length;
}

async function auditConversations(tenantId, cfg) {
  const since = new Date(Date.now() - 864e5).toISOString();
  const convs = all('SELECT * FROM conversations WHERE tenant_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?', tenantId, since, cfg.amostra_auditoria);
  const results = [];
  for (const c of convs) {
    if (c.auditoria?.em && c.auditoria.em >= c.updated_at) continue;
    const msgs = listMessages(c.id).slice(-20);
    if (msgs.length < 2) continue;
    let r;
    if (aiEnabled()) {
      r = await structured({
        system: `Você é ${cfg.nome_exibicao}, gerente de atendimento. Avalie a conversa de WhatsApp da atendente virtual: cordialidade, precisão, condução para a venda, uso de upsell e se deixou o cliente sem resposta.`,
        prompt: msgs.map((m) => `${m.role === 'user' ? 'CLIENTE' : 'ATENDENTE'}: ${m.content}`).join('\n'),
        schema: REVIEW_SCHEMA, effort: 'low',
      });
    } else {
      r = { aprovado: true, nota: (c.pedidos || []).length ? 9 : 7, feedback: (c.pedidos || []).length ? 'Venda concluída.' : 'Conduzir mais rápido para o fechamento.' };
    }
    run('UPDATE conversations SET data = json_set(data, \'$.auditoria\', json(?)) WHERE id = ?', JSON.stringify({ ...r, em: now() }), c.id);
    results.push(r);
    if (r.nota < 7) createTask(tenantId, { agent: 'atendente', title: `Melhorar atendimento (${c.contact_name || c.contact}): ${r.feedback}`, created_by: 'gerente', priority: 'alta' });
  }
  if (results.length) {
    const media = results.reduce((s, r) => s + r.nota, 0) / results.length;
    logActivity(tenantId, 'gerente', 'auditoria', `Auditou ${results.length} atendimento(s): nota média ${media.toFixed(1)}`, {}, media >= 7 ? 'success' : 'warning');
  }
  return results;
}

function checkUnanswered(tenantId) {
  const limite = new Date(Date.now() - 5 * 60e3).toISOString();
  const convs = all("SELECT * FROM conversations WHERE tenant_id = ? AND status = 'bot' AND updated_at <= ? AND updated_at >= ?", tenantId, limite, new Date(Date.now() - 864e5).toISOString());
  const pendentes = convs.filter((c) => { const m = listMessages(c.id); return m.length && m[m.length - 1].role === 'user'; });
  for (const c of pendentes) logActivity(tenantId, 'gerente', 'alerta', `Cliente ${c.contact_name || c.contact} sem resposta há mais de 5 min`, { conversation_id: c.id }, 'error');
  return pendentes.length;
}

/** Ciclo do Gerente. */
export async function supervise(tenantId, { sendReport = false, reason = 'rotina' } = {}) {
  const cfg = getAgentConfig(tenantId, 'gerente');
  if (!cfg.enabled) return null;
  const tenant = getTenant(tenantId);
  setAgentStatus(tenantId, 'gerente', 'trabalhando', 'Supervisionando a equipe');
  try {
    const revisados = cfg.revisar_posts_antes_de_publicar ? await reviewPosts(tenantId, cfg) : 0;
    const auditorias = cfg.auditar_atendimentos ? await auditConversations(tenantId, cfg) : [];
    const semResposta = checkUnanswered(tenantId);
    const kpis = await computeKpis(tenantId);

    // cobra entregas: posts programados abaixo da meta
    const social = getAgentConfig(tenantId, 'social');
    const futuros = all("SELECT id FROM posts WHERE tenant_id = ? AND format = 'feed' AND status IN ('agendado','aguardando_aprovacao','revisao_gerente') AND scheduled_at >= ?", tenantId, now());
    if (social.enabled && futuros.length < Math.min(cfg.metas.posts_semana, social.posts_feed_semana)) {
      logActivity(tenantId, 'gerente', 'cobranca', `Agenda de posts com ${futuros.length}/${cfg.metas.posts_semana} — pediu novo planejamento à Social Media`, {}, 'warning');
      await planWeek(tenantId, { reason: 'solicitado pelo Gerente' });
    }
    const fat = kpis.items[0];
    if (fat.meta && fat.progresso < 90) {
      createTask(tenantId, { agent: 'trafego', title: `Projeção de faturamento em ${fat.progresso}% da meta — propor ação para recuperar vendas`, created_by: 'gerente', priority: 'alta' });
    }

    const resumo = await buildReport(tenant, cfg, kpis, { revisados, auditorias, semResposta });
    run('INSERT INTO reports (id, tenant_id, agent, kind, data, created_at) VALUES (?,?,?,?,?,?)', uid('rep_'), tenantId, 'gerente', 'relatorio', JSON.stringify({ ...resumo, kpis: kpis.items, motivo: reason }), now());
    logActivity(tenantId, 'gerente', 'relatorio', `Relatório gerado: ${resumo.titulo}`, {}, 'success');
    if (sendReport && cfg.relatorio.whatsapp_dono) {
      try { await sendWhatsApp(tenant, cfg.relatorio.whatsapp_dono, resumo.texto_whatsapp); logActivity(tenantId, 'gerente', 'relatorio_enviado', 'Relatório enviado ao dono pelo WhatsApp'); } catch (err) { logActivity(tenantId, 'gerente', 'erro', `Falha ao enviar relatório: ${err.message}`, {}, 'error'); }
    }
    return { ...resumo, kpis };
  } finally {
    setAgentStatus(tenantId, 'gerente', 'online', '');
  }
}

async function buildReport(tenant, cfg, kpis, ctx) {
  const tarefasAbertas = listTasks(tenant.id).filter((t) => ['todo', 'doing', 'review'].includes(t.status)).length;
  const linhas = kpis.items.map((i) => `${i.label}: ${i.fmt === 'brl' ? brl(i.valor) : i.valor} / meta ${i.fmt === 'brl' ? brl(i.meta) : i.meta} (${i.progresso}%)`);
  if (aiEnabled()) {
    return structured({
      system: `Você é ${cfg.nome_exibicao}, gerente da equipe virtual de IA da floricultura. Reporte ao dono de forma objetiva, com números e próximas ações. Instruções do dono: ${cfg.instrucoes}`,
      prompt: `Indicadores vs metas:\n${linhas.join('\n')}\nPosts revisados hoje: ${ctx.revisados}. Atendimentos auditados: ${ctx.auditorias.length}. Clientes sem resposta: ${ctx.semResposta}. Tarefas abertas: ${tarefasAbertas}.`,
      schema: { type: 'object', additionalProperties: false, required: ['titulo', 'destaques', 'riscos', 'proximas_acoes', 'texto_whatsapp'], properties: { titulo: { type: 'string' }, destaques: { type: 'array', items: { type: 'string' } }, riscos: { type: 'array', items: { type: 'string' } }, proximas_acoes: { type: 'array', items: { type: 'string' } }, texto_whatsapp: { type: 'string' } } },
      effort: 'medium',
    });
  }
  const abaixo = kpis.items.filter((i) => i.progresso < 90);
  return {
    titulo: abaixo.length ? `${abaixo.length} indicador(es) abaixo da meta` : 'Tudo dentro da meta 🎉',
    destaques: kpis.items.filter((i) => i.progresso >= 100).map((i) => `${i.label} batendo a meta (${i.progresso}%)`),
    riscos: abaixo.map((i) => `${i.label} em ${i.progresso}% da meta`),
    proximas_acoes: ['Tráfego: reforçar campanhas com melhor ROAS', 'Social: manter agenda de posts da semana', 'Atendente: oferecer complemento em todo fechamento'],
    texto_whatsapp: `🌷 *Relatório da Equipe Virtual — ${tenant.name}*\n\n${linhas.map((l) => '• ' + l).join('\n')}\n\nTarefas abertas: ${tarefasAbertas}`,
  };
}

export const latestReport = (tenantId, agent = 'gerente') => get('SELECT * FROM reports WHERE tenant_id = ? AND agent = ? ORDER BY created_at DESC LIMIT 1', tenantId, agent);
