// Store do servidor: SQLite nativo do Node (uma tabela de documentos JSON por coleção).
// Para muitas lojas, troque por Postgres mantendo a mesma interface (get/list/put/del).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function createSqliteStore(file = process.env.DB_PATH || 'data/iflores.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, tenant_id TEXT, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, PRIMARY KEY (coll, id));
    CREATE INDEX IF NOT EXISTS idx_docs_tenant ON docs (coll, tenant_id);`);
  const qGet = db.prepare('SELECT data FROM docs WHERE coll = ? AND id = ?');
  const qListT = db.prepare('SELECT data FROM docs WHERE coll = ? AND tenant_id = ?');
  const qListAll = db.prepare('SELECT data FROM docs WHERE coll = ?');
  const qPut = db.prepare(`INSERT INTO docs (coll, id, tenant_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(coll, id) DO UPDATE SET tenant_id = excluded.tenant_id, data = excluded.data, updated_at = excluded.updated_at`);
  const qDel = db.prepare('DELETE FROM docs WHERE coll = ? AND id = ?');
  return {
    get: (coll, id) => { const r = qGet.get(coll, id); return r ? JSON.parse(r.data) : null; },
    list: (coll, tenantId, filter) => (tenantId == null ? qListAll.all(coll) : qListT.all(coll, tenantId)).map((r) => JSON.parse(r.data)).filter((d) => !filter || filter(d)),
    put: (coll, doc) => {
      const t = new Date().toISOString(); const prev = qGet.get(coll, doc.id);
      const saved = { ...doc, created_at: prev ? JSON.parse(prev.data).created_at : doc.created_at || t, updated_at: t };
      qPut.run(coll, doc.id, doc.tenant_id ?? null, JSON.stringify(saved), saved.created_at, t);
      return saved;
    },
    del: (coll, id) => { qDel.run(coll, id); },
  };
}
