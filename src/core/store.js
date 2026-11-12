// Armazenamento de documentos usado por todo o núcleo, com ISOLAMENTO OBRIGATÓRIO entre lojas.
//
// Regra do produto: nenhuma loja pode ler, alterar ou receber dados de outra. Por isso todo trabalho
// de uma loja roda dentro de comLoja(tenantId, fn) e o store recusa (IsolationError) qualquer leitura
// ou escrita de documento cujo tenant_id seja diferente da loja do contexto. Isso vale mesmo que um
// trecho de código esqueça de filtrar: o erro aparece em vez de vazar dados.
//
// Implementações: SQLite no servidor (src/server/sqlite-store.js) e memória na demo e nos testes.

let current = null;
let ctx = (() => { let t = null; return { get: () => t, run: (tenantId, fn) => { const prev = t; t = tenantId; try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(() => { t = prev; }); t = prev; return r; } catch (e) { t = prev; throw e; } } }; })();

export class IsolationError extends Error {
  constructor(msg) { super(`Isolamento entre lojas: ${msg}`); this.name = 'IsolationError'; this.status = 403; }
}

/** No servidor usamos AsyncLocalStorage (cada requisição/rotina tem sua loja). */
export function setContextProvider(provider) { ctx = provider; }
export const lojaAtual = () => ctx.get() ?? null;
/** Executa fn com a loja definida no contexto. Todo acesso a dados fica restrito a ela. */
export function comLoja(tenantId, fn) {
  if (!tenantId) throw new IsolationError('loja não informada');
  const atual = ctx.get();
  if (atual && atual !== tenantId) throw new IsolationError(`tentativa de trocar de loja (${atual} → ${tenantId}) dentro de um contexto`);
  return ctx.run(tenantId, fn);
}

export function setStore(store) { current = store; }

function guard(raw) {
  const check = (coll, doc, op) => {
    const t = ctx.get();
    if (t && doc && doc.tenant_id !== t) throw new IsolationError(`${op} em ${coll}/${doc.id} pertence a outra loja`);
  };
  return {
    get(coll, id) { const d = raw.get(coll, id); check(coll, d, 'leitura'); return d; },
    list(coll, tenantId, filter) {
      const t = ctx.get();
      if (t && tenantId !== t) throw new IsolationError(`listagem de ${coll} ${tenantId == null ? 'de todas as lojas' : `da loja ${tenantId}`} dentro do contexto de ${t}`);
      return raw.list(coll, tenantId, filter);
    },
    put(coll, doc) {
      if (!doc?.id) throw new Error(`Documento sem id em ${coll}`);
      if (!doc.tenant_id) throw new IsolationError(`documento ${coll}/${doc.id} sem tenant_id`);
      check(coll, doc, 'escrita');
      const prev = raw.get(coll, doc.id);
      if (prev && prev.tenant_id !== doc.tenant_id) throw new IsolationError(`${coll}/${doc.id} já pertence a outra loja`);
      return raw.put(coll, doc);
    },
    del(coll, id) { check(coll, raw.get(coll, id), 'remoção'); raw.del(coll, id); },
  };
}

export function db() {
  if (!current) throw new Error('Store não configurado: chame setStore() antes de usar o núcleo');
  return guard(current);
}

/** Store em memória indexado por loja (demo e testes). */
export function createMemoryStore() {
  const docs = new Map(); const idx = new Map();
  const c = (m, k) => { if (!m.has(k)) m.set(k, new Map()); return m.get(k); };
  const clone = (x) => (x == null ? x : structuredClone(x));
  return {
    get: (coll, id) => clone(c(docs, coll).get(id) ?? null),
    list: (coll, tenantId, filter) => {
      const src = tenantId == null ? c(docs, coll).values() : c(c(idx, coll), tenantId).values();
      const out = []; for (const d of src) if (!filter || filter(d)) out.push(clone(d));
      return out;
    },
    put: (coll, doc) => {
      const t = new Date().toISOString(); const prev = c(docs, coll).get(doc.id);
      const saved = clone({ ...doc, created_at: prev?.created_at || doc.created_at || t, updated_at: t });
      c(docs, coll).set(doc.id, saved); c(c(idx, coll), saved.tenant_id).set(doc.id, saved);
      return clone(saved);
    },
    del: (coll, id) => { const d = c(docs, coll).get(id); if (d) { c(docs, coll).delete(id); c(c(idx, coll), d.tenant_id).delete(id); } },
  };
}

/** Fila por chave: mensagens da mesma conversa (ou da mesma loja) são processadas uma de cada vez. */
const filas = new Map();
export function serial(key, fn) {
  const prev = filas.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  filas.set(key, tail);
  tail.then(() => { if (filas.get(key) === tail) filas.delete(key); });
  return next;
}
