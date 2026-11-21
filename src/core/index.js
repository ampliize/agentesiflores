// Ponto de entrada do núcleo: inicializa as reações entre agentes e expõe as rotinas.
import { setStore } from './store.js';
import { active, getConfig } from './team.js';
import * as mari from './agents/mari.js';
import * as caio from './agents/caio.js';
import * as alex from './agents/alex.js';
import { executarAutomacoes, registrarAutomacoes, enviarResumoDono } from './automacoes.js';
import { sincronizar, processarFila } from './crm.js';
import { importarAnalytics } from './agents/alex-analise.js';
import { log } from './events.js';

let registrado = false;
export function init(store) {
  setStore(store);
  if (!registrado) { mari.registrar(); caio.registrar(); registrarAutomacoes(); registrado = true; }
}

// controle de frequência por loja (cada loja tem o seu relógio; uma não atrasa a outra)
const ultimo = new Map();
const devido = (k, ms) => { const t = ultimo.get(k) || 0; if (Date.now() - t < ms) return false; ultimo.set(k, Date.now()); return true; };

/** Rotinas automáticas de UMA loja. O servidor chama dentro de comLoja(tenantId). */
export async function rotinas(tenantId, { forcar = false } = {}) {
  const H = 3600e3; const feitos = [];
  const run = async (nome, agente, ms, fn) => {
    if ((agente && !active(tenantId, agente)) || !(forcar || devido(`${tenantId}:${nome}`, ms))) return;
    try { await fn(); feitos.push(nome); } catch (e) { log(tenantId, agente || 'alex', `Erro na rotina ${nome}: ${e.message}`, { level: 'error' }); }
  };
  await run('automacoes', null, 10 * 60e3, () => executarAutomacoes(tenantId));
  await run('sincronizacao', null, 15 * 60e3, async () => { await sincronizar(tenantId).catch(() => {}); await importarAnalytics(tenantId).catch(() => {}); await processarFila(tenantId); });
  await run('mari:publicar', 'mari', 60e3, () => mari.publicarDevidos(tenantId));
  await run('mari:plano', 'mari', 7 * 24 * H, () => mari.planejarSemana(tenantId));
  await run('caio', 'caio', 6 * H, () => caio.analisar(tenantId));
  await run('alex', 'alex', 24 * H, async () => {
    const r = await alex.rotina(tenantId);
    if (r) await enviarResumoDono(tenantId, r.resumo.texto, getConfig(tenantId, 'alex').resumo_diario?.whatsapp_dono);
  });
  return feitos;
}
