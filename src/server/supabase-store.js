// Store do servidor no Supabase (tabela public.docs, ver supabase/migrations/0001_init.sql).
// Usa a chave de serviço, que fica só no servidor (variável SUPABASE_SERVICE_KEY, na Vercel).
// O isolamento entre lojas é feito pelo store do núcleo (src/core/store.js): aqui cada operação
// já recebe o tenant_id, e o banco também exige tenant_id em toda linha.
import { createClient } from '@supabase/supabase-js';

const PAGINA = 1000; // limite padrão de linhas por consulta no Supabase

export function createSupabaseStore({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY } = {}) {
  if (!url || !key) throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY');
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const ok = (r) => { if (r.error) throw new Error(`Supabase: ${r.error.message}`); return r.data; };

  return {
    async get(coll, id) {
      const row = ok(await sb.from('docs').select('data').eq('coll', coll).eq('id', id).maybeSingle());
      return row ? row.data : null;
    },
    async list(coll, tenantId, filter) {
      const out = [];
      for (let de = 0; ; de += PAGINA) {
        let q = sb.from('docs').select('data').eq('coll', coll).order('id', { ascending: true }).range(de, de + PAGINA - 1);
        if (tenantId != null) q = q.eq('tenant_id', tenantId);
        const rows = ok(await q);
        for (const r of rows) if (!filter || filter(r.data)) out.push(r.data);
        if (rows.length < PAGINA) break;
      }
      return out;
    },
    async put(coll, doc) {
      const prev = await this.get(coll, doc.id);
      const agora = new Date().toISOString();
      const saved = { ...doc, created_at: prev?.created_at || doc.created_at || agora, updated_at: agora };
      ok(await sb.from('docs').upsert({ coll, id: doc.id, tenant_id: doc.tenant_id, data: saved }, { onConflict: 'coll,id' }));
      return saved;
    },
    async del(coll, id) {
      ok(await sb.from('docs').delete().eq('coll', coll).eq('id', id));
    },
  };
}
