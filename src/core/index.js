// Ponto de entrada do núcleo: inicializa as reações entre agentes e expõe as rotinas.
import { setStore } from './store.js';
import { active } from './team.js';
import * as mari from './agents/mari.js';
import * as caio from './agents/caio.js';
import * as flora from './agents/flora.js';
import * as alex from './agents/alex.js';
import { log } from './events.js';

let registrado = false;
export function init(store) {
  setStore(store);
  if (!registrado) { mari.registrar(); caio.registrar(); registrado = true; }
}

const ultimo = new Map();
const devido = (k, ms) => { const t = ultimo.get(k) || 0; if (Date.now() - t < ms) return false; ultimo.set(k, Date.now()); return true; };

/** Rotinas automáticas de uma loja (chamadas pelo agendador do servidor ou da demo). */
export async function rotinas(tenantId, { forcar = false } = {}) {
  const H = 3600e3; const feitos = [];
  const run = async (nome, agente, ms, fn) => {
    if (!active(tenantId, agente) || !(forcar || devido(`${tenantId}:${nome}`, ms))) return;
    try { await fn(); feitos.push(nome); } catch (e) { log(tenantId, agente, `Erro na rotina ${nome}: ${e.message}`, { level: 'error' }); }
  };
  await run('flora', 'flora', 10 * 60e3, () => flora.rotina(tenantId));
  await run('mari:publicar', 'mari', 60e3, () => mari.publicarDevidos(tenantId));
  await run('mari:plano', 'mari', 7 * 24 * H, () => mari.planejarSemana(tenantId));
  await run('caio', 'caio', 6 * H, () => caio.analisar(tenantId));
  await run('alex', 'alex', 24 * H, () => alex.rotina(tenantId));
  return feitos;
}
