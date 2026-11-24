-- O servidor usa a chave service_role (só no backend). A RLS da tabela docs continua ativa
-- e anon/authenticated seguem sem acesso; o service_role precisa dos privilégios de tabela.
grant select, insert, update, delete on public.docs to service_role;
