-- Equipe dos Sonhos iFlores: banco compartilhado com isolamento por loja (tenant_id + RLS).
-- Regra: todo dado de loja tem tenant_id obrigatório. O navegador nunca acessa o banco
-- diretamente; só as rotas do servidor usam a chave de serviço (que ignora RLS, por isso o
-- filtro por tenant_id é feito pelo store em src/core/store.js e testado em test/isolamento.test.js).

-- Documentos genéricos: cada coleção do núcleo (produtos, pedidos, conversas, tarefas...) é uma linha.
create table if not exists public.docs (
  coll       text        not null,
  id         text        not null,
  tenant_id  text        not null,
  data       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (coll, id),
  check (length(tenant_id) > 0)
);

create index if not exists docs_tenant_coll_idx on public.docs (tenant_id, coll);
create index if not exists docs_coll_data_gin on public.docs using gin (data);

-- Lojas (tenants) ficam na mesma tabela: coll = 'tenants', tenant_id = id da própria loja.

-- RLS ligado e sem políticas para papéis públicos: anon e authenticated não leem nem escrevem.
-- A chave de serviço (somente no servidor) ignora RLS.
alter table public.docs enable row level security;

revoke all on public.docs from anon, authenticated;

-- Atualiza updated_at automaticamente
create or replace function public.docs_touch() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists docs_touch_trg on public.docs;
create trigger docs_touch_trg before update on public.docs
  for each row execute function public.docs_touch();
