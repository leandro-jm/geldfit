-- migrate:up

create extension if not exists pgcrypto;
create extension if not exists unaccent;

-- Papéis de login (app_user, app_worker) são criados em db/init/01-roles.sh.
-- Em ambientes onde não existem, criamos sem login para as migrations não falharem.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker nologin bypassrls;
  end if;
end $$;

grant usage on schema public to app_user, app_worker;

-- Usuário corrente da sessão (definido por withUserContext via `set local app.user_id`).
create or replace function app_uid() returns text
language sql stable
as $$ select nullif(current_setting('app.user_id', true), '') $$;

-- Normaliza descrições para deduplicação e regras de categorização.
create or replace function normalize_text(t text) returns text
language sql immutable
as $$ select trim(regexp_replace(lower(unaccent('unaccent', coalesce(t, ''))), '[^a-z0-9]+', ' ', 'g')) $$;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Better Auth (snake_case via mapeamento de campos)
-- ---------------------------------------------------------------------------
create table auth_user (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table auth_session (
  id text primary key,
  user_id text not null references auth_user(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on auth_session (user_id);

create table auth_account (
  id text primary key,
  user_id text not null references auth_user(id) on delete cascade,
  account_id text not null,
  provider_id text not null,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on auth_account (user_id);

create table auth_verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on auth_verification (identifier);

grant select, insert, update, delete on auth_user, auth_session, auth_account, auth_verification to app_user, app_worker;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_by text not null references auth_user(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  purge_after timestamptz
);

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  role text not null check (role in ('owner', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on memberships (user_id);

create table workspace_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  timezone text not null default 'America/Sao_Paulo',
  balance_floor_cents bigint not null default 0,
  variable_window_months int not null default 3 check (variable_window_months between 3 and 6),
  variable_monthly_cents bigint not null default 0 check (variable_monthly_cents >= 0),
  optimistic_factor numeric(4,2) not null default 0.85 check (optimistic_factor > 0),
  pessimistic_factor numeric(4,2) not null default 1.15 check (pessimistic_factor > 0),
  quiet_start time not null default '21:00',
  quiet_end time not null default '08:00',
  reminder_time time not null default '09:00',
  emergency_months_target numeric(4,1) not null default 6,
  usd_min_pct numeric(5,2),
  usd_max_pct numeric(5,2),
  updated_at timestamptz not null default now()
);
create trigger workspace_settings_touch before update on workspace_settings
  for each row execute function touch_updated_at();

create table invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('member', 'viewer')),
  token_hash text not null unique,
  invited_by text not null references auth_user(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table consents (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null check (kind in ('terms', 'privacy', 'llm_processing')),
  version text not null,
  granted_at timestamptz not null default now(),
  ip text
);

-- Canais vinculados (WhatsApp). Cada número pertence a um único usuário.
create table user_channels (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null check (kind in ('whatsapp')),
  address text not null,
  default_workspace_id uuid references workspaces(id) on delete set null,
  verification_code_hash text,
  code_expires_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, address)
);
create index on user_channels (user_id);

-- ---------------------------------------------------------------------------
-- Helpers de autorização (SECURITY DEFINER evita recursão de RLS em memberships)
-- ---------------------------------------------------------------------------
create or replace function ws_role(ws uuid) returns text
language sql stable security definer set search_path = public
as $$ select role from memberships where workspace_id = ws and user_id = app_uid() $$;

create or replace function is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from memberships m join workspaces w on w.id = m.workspace_id
  where m.workspace_id = ws and m.user_id = app_uid() and w.deleted_at is null
) $$;

create or replace function can_write(ws uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(ws_role(ws) in ('owner', 'member'), false) and is_member(ws) $$;

create or replace function is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(ws_role(ws) = 'owner', false) and is_member(ws) $$;

-- migrate:down
drop function if exists is_owner(uuid), can_write(uuid), is_member(uuid), ws_role(uuid) cascade;
drop table if exists user_channels, consents, invites, workspace_settings, memberships, workspaces,
  auth_verification, auth_account, auth_session, auth_user cascade;
drop function if exists touch_updated_at(), normalize_text(text), app_uid();
