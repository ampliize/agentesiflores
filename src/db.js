// Camada de persistência (SQLite nativo do Node 22). Cada tabela guarda colunas
// de índice + um campo `data` JSON, para evoluir o schema sem migrações pesadas no MVP.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_PATH = process.env.DB_PATH || path.resolve('data/iflores.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  iflores_store_id TEXT UNIQUE,
  api_key_hash TEXT,
  api_key_prefix TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_configs (
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, agent)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'normal',
  created_by TEXT NOT NULL DEFAULT 'dono',
  data TEXT NOT NULL DEFAULT '{}',
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id, status);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  contact TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'bot',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, channel, contact)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho',
  scheduled_at TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_tenant ON posts(tenant_id, status);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  tenant_id TEXT NOT NULL,
  job TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT,
  PRIMARY KEY (tenant_id, job)
);
`);

export const now = () => new Date().toISOString();
export const uid = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');

const parse = (row) => {
  if (!row) return null;
  const { data, ...rest } = row;
  return { ...rest, ...(data ? JSON.parse(data) : {}) };
};
export const parseRows = (rows) => rows.map(parse);
export { parse as parseRow };

export function get(sql, ...params) { return parse(db.prepare(sql).get(...params)); }
export function all(sql, ...params) { return parseRows(db.prepare(sql).all(...params)); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }

/** Separa campos de coluna dos campos extras (que vão para `data`). */
export function split(obj, columns) {
  const cols = {}; const data = {};
  for (const [k, v] of Object.entries(obj)) (columns.includes(k) ? cols : data)[k] = v;
  return { cols, data };
}
