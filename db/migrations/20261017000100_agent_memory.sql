-- migrate:up

-- Memória de longo prazo do agente: fatos que o usuário contou (objetivos, família, preferências,
-- compromissos com data). Extraída das conversas em segundo plano ou gravada a pedido; o usuário vê,
-- edita e apaga em "O que sei sobre você". Fato sensível (LGPD art. 5º II) nasce 'pending' e só entra
-- no contexto do agente depois de confirmado.
create table agent_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  -- personal: só o dono vê; household: membros do workspace também veem (ex.: "filho nasce em março")
  scope text not null default 'personal' check (scope in ('personal', 'household')),
  category text not null check (category in (
    'perfil', 'familia', 'renda', 'objetivo', 'preferencia', 'compromisso', 'restricao', 'contexto')),
  key text not null check (key ~ '^[a-z0-9_.]{2,80}$'), -- slug estável para atualizar em vez de duplicar
  content text not null check (length(content) between 2 and 300),
  value jsonb not null default '{}', -- dados estruturados opcionais (dueDate, amountCents, year...)
  sensitive boolean not null default false,
  status text not null default 'active' check (status in ('active', 'pending', 'archived', 'rejected')),
  source text not null default 'chat' check (source in ('chat', 'question', 'manual', 'tool')),
  source_message_id uuid references messages(id) on delete set null,
  confidence numeric(3, 2) check (confidence between 0 and 1),
  importance smallint not null default 3 check (importance between 1 and 5),
  pinned boolean not null default false,
  expires_at date, -- compromissos com prazo ("cancelar a academia até dezembro")
  confirmed_at timestamptz, -- última confirmação/edição pelo usuário (revalidação de objetivos antigos)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agent_memories_key on agent_memories (workspace_id, user_id, key)
  where status in ('active', 'pending');
create index on agent_memories (workspace_id, user_id, status);
create trigger agent_memories_touch before update on agent_memories
  for each row execute function touch_updated_at();
create trigger agent_memories_notify after insert or update or delete on agent_memories
  for each row execute function notify_data_changed();

grant select, insert, update, delete on agent_memories to app_user, app_worker;

alter table agent_memories enable row level security;
alter table agent_memories force row level security;
create policy mem_read on agent_memories for select
  using (is_member(workspace_id) and (user_id = app_uid() or (scope = 'household' and status = 'active')));
create policy mem_insert on agent_memories for insert
  with check (user_id = app_uid() and is_member(workspace_id));
create policy mem_update on agent_memories for update
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));
create policy mem_delete on agent_memories for delete
  using (user_id = app_uid() and is_member(workspace_id));

-- Perfil financeiro estruturado de cada membro (os detectores proativos leem campos tipados).
-- risk_self é autodeclarado e só ajusta tom e conteúdo educativo: não é suitability (CVM 30).
create table user_financial_profiles (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  life_stage text check (life_stage in (
    'estudante', 'inicio_carreira', 'familia_formando', 'familia_filhos', 'pre_aposentadoria', 'aposentado')),
  dependents smallint check (dependents between 0 and 20),
  income_stability text check (income_stability in (
    'clt', 'servidor', 'autonomo', 'empresario', 'aposentado', 'misto')),
  risk_self text check (risk_self in ('conservador', 'moderado', 'arrojado')),
  risk_declared_at timestamptz,
  objectives text[] not null default '{}',
  interests text[] not null default '{}',
  owns_vehicle boolean,
  owns_home boolean,
  uf char(2),
  -- proatividade: off, baixa (1/semana), normal (3/semana), alta (7/semana)
  nudge_frequency text not null default 'normal' check (nudge_frequency in ('off', 'baixa', 'normal', 'alta')),
  nudge_channels text[] not null default '{whatsapp,web}',
  questions_enabled boolean not null default true,
  memory_auto boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create trigger user_financial_profiles_touch before update on user_financial_profiles
  for each row execute function touch_updated_at();

grant select, insert, update, delete on user_financial_profiles to app_user, app_worker;

alter table user_financial_profiles enable row level security;
alter table user_financial_profiles force row level security;
create policy ufp_self on user_financial_profiles for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

-- Até onde a conversa já passou pela extração de memória
alter table conversations add column memory_cursor_at timestamptz;

-- Ferramentas de servidor do provedor (busca/leitura web) para o controle de custo
alter table llm_usage add column web_search_requests int not null default 0;
alter table llm_usage add column web_fetch_requests int not null default 0;
create index on llm_usage (user_id, purpose, at);

alter table consents drop constraint consents_kind_check;
alter table consents add constraint consents_kind_check
  check (kind in ('terms', 'privacy', 'llm_processing', 'agent_memory', 'proactive_whatsapp'));

-- migrate:down
alter table consents drop constraint consents_kind_check;
delete from consents where kind in ('agent_memory', 'proactive_whatsapp');
alter table consents add constraint consents_kind_check check (kind in ('terms', 'privacy', 'llm_processing'));
drop index if exists llm_usage_user_id_purpose_at_idx;
alter table llm_usage drop column if exists web_search_requests, drop column if exists web_fetch_requests;
alter table conversations drop column if exists memory_cursor_at;
drop table if exists user_financial_profiles;
drop table if exists agent_memories;
