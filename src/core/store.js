// Armazenamento de documentos usado por todo o núcleo. É síncrono e plugável:
//   • servidor: SQLite (src/server/sqlite-store.js)
//   • demo no navegador e testes: memória (createMemoryStore)
// Cada documento tem { id, tenant_id, ...campos }. Coleções: products, insumos, settings, orders,
// customers, conversations, messages, posts, photos, campaigns, tasks, activity, changes, chats,
// perguntas, dias, configs, tenants, jobs.

let current = null;

export function setStore(store) { current = store; }
export function db() {
  if (!current) throw new Error('Store não configurado: chame setStore() antes de usar o núcleo');
  return current;
}

export function createMemoryStore() {
  const colls = new Map();
  const c = (name) => { if (!colls.has(name)) colls.set(name, new Map()); return colls.get(name); };
  const clone = (x) => (x == null ? x : structuredClone(x));
  return {
    get: (coll, id) => clone(c(coll).get(id) ?? null),
    list: (coll, tenantId, filter) => {
      const out = [];
      for (const d of c(coll).values()) if ((tenantId == null || d.tenant_id === tenantId) && (!filter || filter(d))) out.push(clone(d));
      return out;
    },
    put: (coll, doc) => {
      const t = new Date().toISOString();
      const prev = c(coll).get(doc.id);
      const saved = { created_at: prev?.created_at || doc.created_at || t, ...doc, updated_at: t };
      c(coll).set(doc.id, clone(saved));
      return clone(saved);
    },
    del: (coll, id) => { c(coll).delete(id); },
  };
}
