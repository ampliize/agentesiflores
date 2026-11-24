// Contexto de loja por requisição/rotina (Node AsyncLocalStorage). Ativado uma vez no servidor e nos testes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { setContextProvider } from '../core/store.js';

const als = new AsyncLocalStorage();
let ativo = false;
export function ativarContexto() {
  if (ativo) return; ativo = true;
  setContextProvider({ get: () => als.getStore() ?? null, run: (t, fn) => als.run(t, fn) });
}

/** Limite de requisições por loja (janela de 1 minuto): uma loja não consegue degradar as outras. */
const janelas = new Map();
export function dentroDoLimite(tenantId, max = Number(process.env.LIMITE_REQ_POR_MINUTO || 240)) {
  const agora = Date.now(); const j = janelas.get(tenantId);
  if (!j || agora - j.inicio > 60000) { janelas.set(tenantId, { inicio: agora, n: 1 }); return true; }
  j.n += 1; return j.n <= max;
}

/** Executa tarefas por loja com concorrência limitada e tempo máximo por loja. */
export async function porLoja(ids, fn, { concorrencia = Number(process.env.ROTINAS_CONCORRENCIA || 8), timeoutMs = 120000 } = {}) {
  const fila = [...ids]; const erros = [];
  const worker = async () => {
    while (fila.length) {
      const id = fila.shift();
      let timer;
      const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tempo esgotado')), timeoutMs); });
      try { await Promise.race([fn(id), limite]); }
      catch (e) { erros.push({ id, erro: e.message }); }
      finally { clearTimeout(timer); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concorrencia, ids.length) }, worker));
  return erros;
}
