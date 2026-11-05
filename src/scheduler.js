// Agendador: roda os ciclos de cada agente por loja, conforme a configuração do dono.
import { get, run, now } from './db.js';
import { listTenants, getAgentConfig } from './lib/tenants.js';
import { logActivity } from './lib/events.js';
import { runAgent, processTasks } from './agents/index.js';
import { publishDue } from './agents/social.js';

function due(tenantId, job, everyMs) {
  const row = get('SELECT * FROM jobs WHERE tenant_id = ? AND job = ?', tenantId, job);
  if (row && row.next_run_at > now()) return false;
  run(`INSERT INTO jobs (tenant_id, job, next_run_at, last_run_at) VALUES (?,?,?,?)
       ON CONFLICT(tenant_id, job) DO UPDATE SET next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at`,
    tenantId, job, new Date(Date.now() + everyMs).toISOString(), now());
  return true;
}

function reportDue(tenantId, cfg) {
  const [hh, mm] = (cfg.relatorio?.horario || '19:00').split(':').map(Number);
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_LOJA || 'America/Sao_Paulo' }));
  if (local.getHours() * 60 + local.getMinutes() < hh * 60 + mm) return false;
  if (cfg.relatorio?.frequencia === 'semanal' && local.getDay() !== 1) return false;
  const key = `relatorio:${local.toISOString().slice(0, 10)}`;
  if (get('SELECT 1 AS ok FROM jobs WHERE tenant_id = ? AND job = ?', tenantId, key)) return false;
  run('INSERT INTO jobs (tenant_id, job, next_run_at, last_run_at) VALUES (?,?,?,?)', tenantId, key, now(), now());
  return true;
}

const running = new Set();
async function guarded(tenantId, job, fn) {
  const k = `${tenantId}:${job}`; if (running.has(k)) return; running.add(k);
  try { await fn(); } catch (err) { logActivity(tenantId, job.split(':')[0], 'erro', `Erro no ciclo ${job}: ${err.message}`, {}, 'error'); } finally { running.delete(k); }
}

export async function tick() {
  for (const t of listTenants()) {
    const H = 3600e3;
    const social = getAgentConfig(t.id, 'social');
    const trafego = getAgentConfig(t.id, 'trafego');
    const gerente = getAgentConfig(t.id, 'gerente');
    if (social.enabled) {
      guarded(t.id, 'social:publicar', () => publishDue(t.id));
      if (due(t.id, 'social:plano', 7 * 24 * H)) guarded(t.id, 'social:plano', () => runAgent(t.id, 'social', { reason: 'agenda semanal' }));
    }
    if (trafego.enabled && due(t.id, 'trafego:analise', (trafego.frequencia_analise_horas || 6) * H)) guarded(t.id, 'trafego:analise', () => runAgent(t.id, 'trafego', { reason: 'análise programada' }));
    if (gerente.enabled) {
      if (due(t.id, 'gerente:supervisao', 2 * H)) guarded(t.id, 'gerente:supervisao', () => runAgent(t.id, 'gerente', { reason: 'supervisão programada' }));
      if (reportDue(t.id, gerente)) guarded(t.id, 'gerente:relatorio', () => runAgent(t.id, 'gerente', { sendReport: true, reason: 'relatório do dia' }));
    }
    guarded(t.id, 'tarefas', () => processTasks(t.id));
  }
}

export function startScheduler() {
  const every = Number(process.env.SCHEDULER_INTERVAL || 60) * 1000;
  setTimeout(() => tick().catch(console.error), 3000);
  return setInterval(() => tick().catch(console.error), every);
}
