# Banco no Supabase (modelo compartilhado com isolamento por loja)

- Um único projeto Supabase para todas as lojas.
- Tabela `public.docs`: cada documento tem `coll` (coleção), `id`, `tenant_id` (obrigatório) e `data` (jsonb).
- Row Level Security ligado: `anon` e `authenticated` não têm acesso. Só o servidor acessa, com a chave de serviço.
- Chave de serviço fica somente nas variáveis de ambiente da Vercel (`SUPABASE_SERVICE_KEY`), nunca no código nem no navegador.
- Isolamento entre lojas é garantido em duas camadas: o store exige `tenant_id` em toda operação
  (`src/core/store.js`) e o banco rejeita documento sem `tenant_id`.

## Aplicar a migração

Pelo painel do Supabase: SQL Editor → cole `supabase/migrations/0001_init.sql` → Run.
