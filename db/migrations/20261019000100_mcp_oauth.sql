-- migrate:up

-- Conexão de assistentes externos (Claude, ChatGPT...) via MCP, com OAuth 2.1 próprio:
-- registro dinâmico de cliente, código de autorização com PKCE e tokens opacos (só o hash é gravado).

-- Clientes OAuth registrados dinamicamente (RFC 7591). Públicos: sem segredo, PKCE obrigatório.
create table mcp_clients (
  id text primary key check (length(id) <= 100),
  client_name text not null check (length(client_name) <= 200),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
grant select, insert, update, delete on mcp_clients to app_user, app_worker;

-- Códigos de autorização: vida curta e uso único (consumidos por mcp_consume_code).
create table mcp_auth_codes (
  code_hash text primary key,
  client_id text not null references mcp_clients(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  redirect_uri text not null check (length(redirect_uri) <= 2000),
  code_challenge text not null check (length(code_challenge) between 43 and 128),
  scope text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on mcp_auth_codes (expires_at);

alter table mcp_auth_codes enable row level security;
alter table mcp_auth_codes force row level security;
create policy mac_self on mcp_auth_codes for all using (user_id = app_uid()) with check (user_id = app_uid());
grant select, insert, update, delete on mcp_auth_codes to app_user, app_worker;

-- Uma concessão por autorização: um par access/refresh que gira a cada refresh.
create table mcp_grants (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id text not null references mcp_clients(id) on delete cascade,
  scope text not null,
  access_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_hash text not null unique,
  refresh_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index on mcp_grants (user_id);

alter table mcp_grants enable row level security;
alter table mcp_grants force row level security;
create policy mg_self on mcp_grants for all using (user_id = app_uid()) with check (user_id = app_uid());
grant select, insert, update, delete on mcp_grants to app_user, app_worker;

-- Troca do código no /token (ainda sem usuário no contexto): apaga e devolve o código válido.
create or replace function mcp_consume_code(p_hash text)
returns table (client_id text, user_id text, workspace_id uuid, redirect_uri text, code_challenge text, scope text,
  expires_at timestamptz)
language sql volatile security definer set search_path = public
as $$
  delete from mcp_auth_codes c where c.code_hash = p_hash
  returning c.client_id, c.user_id, c.workspace_id, c.redirect_uri, c.code_challenge, c.scope, c.expires_at
$$;

-- Valida o access token de cada chamada MCP (marca o uso no máximo uma vez por minuto).
create or replace function mcp_resolve_access(p_hash text)
returns table (grant_id uuid, user_id text, workspace_id uuid, client_id text, scope text)
language plpgsql volatile security definer set search_path = public
as $$
begin
  return query
    update mcp_grants g set last_used_at = now()
    where g.access_hash = p_hash and g.revoked_at is null and g.access_expires_at > now()
      and (g.last_used_at is null or g.last_used_at < now() - interval '1 minute')
    returning g.id, g.user_id, g.workspace_id, g.client_id, g.scope;
  if not found then
    return query
      select g.id, g.user_id, g.workspace_id, g.client_id, g.scope from mcp_grants g
      where g.access_hash = p_hash and g.revoked_at is null and g.access_expires_at > now();
  end if;
end $$;

-- Refresh com rotação: o refresh antigo deixa de valer na hora.
create or replace function mcp_rotate_refresh(
  p_old_refresh text, p_client_id text, p_access_hash text, p_access_exp timestamptz,
  p_refresh_hash text, p_refresh_exp timestamptz)
returns table (grant_id uuid, user_id text, workspace_id uuid, scope text)
language sql volatile security definer set search_path = public
as $$
  update mcp_grants g set access_hash = p_access_hash, access_expires_at = p_access_exp,
    refresh_hash = p_refresh_hash, refresh_expires_at = p_refresh_exp, last_used_at = now()
  where g.refresh_hash = p_old_refresh and g.client_id = p_client_id
    and g.revoked_at is null and g.refresh_expires_at > now()
  returning g.id, g.user_id, g.workspace_id, g.scope
$$;

-- Revogação pelo próprio cliente (RFC 7009): aceita o access ou o refresh token.
create or replace function mcp_revoke_token(p_hash text)
returns void
language sql volatile security definer set search_path = public
as $$
  update mcp_grants set revoked_at = now()
  where (access_hash = p_hash or refresh_hash = p_hash) and revoked_at is null
$$;

grant execute on function mcp_consume_code(text) to app_user;
grant execute on function mcp_resolve_access(text) to app_user;
grant execute on function mcp_rotate_refresh(text, text, text, timestamptz, text, timestamptz) to app_user;
grant execute on function mcp_revoke_token(text) to app_user;

-- migrate:down
drop function if exists mcp_revoke_token(text);
drop function if exists mcp_rotate_refresh(text, text, text, timestamptz, text, timestamptz);
drop function if exists mcp_resolve_access(text);
drop function if exists mcp_consume_code(text);
drop table mcp_grants;
drop table mcp_auth_codes;
drop table mcp_clients;
