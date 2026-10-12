-- migrate:up

-- ---------------------------------------------------------------------------
-- Contas, cartões e categorias
-- ---------------------------------------------------------------------------
create table accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  institution text not null,
  type text not null check (type in ('checking', 'savings', 'investment', 'cash')),
  name text not null,
  opening_balance_cents bigint not null default 0,
  opening_date date not null,
  is_private boolean not null default false,
  owner_user_id text references auth_user(id) on delete set null,
  archived_at timestamptz,
  created_by text references auth_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_private or owner_user_id is not null)
);
create index on accounts (workspace_id);
create trigger accounts_touch before update on accounts for each row execute function touch_updated_at();

create table cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  account_id uuid references accounts(id) on delete set null, -- conta que paga a fatura
  name text not null,
  last4 text check (last4 ~ '^[0-9]{4}$'),
  holder_tag text, -- cartão adicional de terceiro
  limit_cents bigint not null default 0 check (limit_cents >= 0),
  closing_day int not null check (closing_day between 1 and 31),
  due_day int not null check (due_day between 1 and 31),
  is_private boolean not null default false,
  owner_user_id text references auth_user(id) on delete set null,
  archived_at timestamptz,
  created_by text references auth_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_private or owner_user_id is not null)
);
create index on cards (workspace_id);
create trigger cards_touch before update on cards for each row execute function touch_updated_at();

create table categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('income', 'expense')),
  parent_id uuid references categories(id) on delete set null,
  icon text,
  color text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, name)
);

-- ---------------------------------------------------------------------------
-- Anexos (arquivo original em disco local, criptografado)
-- ---------------------------------------------------------------------------
create table attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  uploaded_by text references auth_user(id) on delete set null,
  storage_key text not null,
  filename text not null,
  mime text not null,
  size_bytes bigint not null,
  sha256 text not null,
  doc_type text check (doc_type in ('bank_statement', 'card_bill', 'pension_statement', 'brokerage_note', 'position_statement', 'receipt', 'unknown')),
  extracted_json jsonb,
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'extracted', 'imported', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (workspace_id, sha256)
);

-- ---------------------------------------------------------------------------
-- Faturas de cartão (derivadas das transações do cartão)
-- ---------------------------------------------------------------------------
create table card_statements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  card_id uuid not null references cards(id) on delete cascade,
  ref_month date not null check (extract(day from ref_month) = 1), -- mês do fechamento
  closing_date date not null,
  due_date date not null,
  reported_total_cents bigint, -- total impresso na fatura importada (checagem)
  status text not null default 'open' check (status in ('open', 'closed', 'paid')),
  created_at timestamptz not null default now(),
  unique (card_id, ref_month)
);
create index on card_statements (workspace_id, due_date);

-- ---------------------------------------------------------------------------
-- Recorrências (materializadas como transações scheduled)
-- ---------------------------------------------------------------------------
create table recurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  card_id uuid references cards(id) on delete cascade,
  description text not null,
  amount_cents bigint not null check (amount_cents > 0),
  direction text not null check (direction in ('in', 'out')),
  category_id uuid references categories(id) on delete set null,
  rule text not null, -- RRULE (subconjunto: FREQ=MONTHLY|WEEKLY|YEARLY)
  start_date date not null,
  end_date date,
  amount_mode text not null default 'fixed' check (amount_mode in ('fixed', 'average_n_months')),
  average_months int check (average_months between 2 and 12),
  auto_post boolean not null default false,
  is_bill boolean not null default false, -- conta a pagar com lembrete de vencimento
  paused_at timestamptz,
  created_by text references auth_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((account_id is null) <> (card_id is null)),
  check (end_date is null or end_date >= start_date)
);
create index on recurrences (workspace_id);
create trigger recurrences_touch before update on recurrences for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Transações
-- ---------------------------------------------------------------------------
create table transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  card_id uuid references cards(id) on delete cascade,
  date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  direction text not null check (direction in ('in', 'out')),
  kind text not null default 'regular' check (kind in ('regular', 'transfer', 'card_payment')),
  category_id uuid references categories(id) on delete set null,
  description text not null default '',
  status text not null default 'posted' check (status in ('posted', 'scheduled')),
  source text not null default 'chat' check (source in ('chat', 'import', 'recurrence', 'manual', 'reminder')),
  attachment_id uuid references attachments(id) on delete set null,
  recurrence_id uuid references recurrences(id) on delete set null,
  transfer_id uuid,
  card_statement_id uuid references card_statements(id) on delete set null, -- compra no cartão
  pays_statement_id uuid references card_statements(id) on delete set null, -- pagamento de fatura
  installment_group_id uuid,
  installment_n int,
  installment_total int,
  dedupe_hash text,
  confidence numeric(3,2),
  created_by text references auth_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((account_id is null) <> (card_id is null)),
  check (kind <> 'transfer' or (transfer_id is not null and account_id is not null)),
  check (kind <> 'card_payment' or (pays_statement_id is not null and account_id is not null and direction = 'out')),
  check ((installment_group_id is null) = (installment_n is null)),
  check (installment_n is null or (installment_n between 1 and installment_total))
);
create index on transactions (workspace_id, date);
create index on transactions (account_id, date);
create index on transactions (card_statement_id);
create index on transactions (recurrence_id, date);
create index on transactions (installment_group_id);
create index on transactions (transfer_id);
create index on transactions (workspace_id, dedupe_hash);
create trigger transactions_touch before update on transactions for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Previdência
-- ---------------------------------------------------------------------------
create table pension_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  name text not null,
  owner_user_id text references auth_user(id) on delete set null,
  debit_account_id uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

create table pension_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  plan_id uuid not null references pension_plans(id) on delete cascade,
  ref_month date not null check (extract(day from ref_month) = 1),
  balance_cents bigint not null,
  contrib_participant_cents bigint not null default 0,
  contrib_sponsor_cents bigint not null default 0,
  attachment_id uuid references attachments(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (plan_id, ref_month)
);

-- ---------------------------------------------------------------------------
-- Conversas, drafts, auditoria
-- ---------------------------------------------------------------------------
create table conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  channel text not null check (channel in ('web', 'whatsapp')),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index on conversations (workspace_id, user_id, channel, last_message_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id text references auth_user(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null default '',
  parts jsonb not null default '[]', -- anexos, drafts, blocos estruturados
  tool_calls jsonb,
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, created_at);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  created_by text not null references auth_user(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  preview jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  result jsonb,
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index on drafts (workspace_id, created_by, status);

create table audit_log (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id text references auth_user(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  draft_id uuid references drafts(id) on delete set null,
  undone_at timestamptz,
  at timestamptz not null default now()
);
create index on audit_log (workspace_id, actor_id, at desc);

-- ---------------------------------------------------------------------------
-- Lembretes
-- ---------------------------------------------------------------------------
create table reminder_prefs (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null check (kind in ('due_bill', 'statement_closed', 'statement_due', 'balance_alert', 'weekly_summary', 'monthly_summary', 'import_reminder', 'budget_alert', 'insights')),
  enabled boolean not null default true,
  primary key (workspace_id, user_id, kind)
);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null,
  target_type text,
  target_id uuid,
  fire_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  channel text,
  payload jsonb not null default '{}',
  dedupe_key text not null unique,
  attempts int not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index on reminders (status, fire_at);
create index on reminders (user_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Projeção (cache) e P1/P2
-- ---------------------------------------------------------------------------
create table projection_snapshots (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  computed_at timestamptz not null default now(),
  months jsonb not null,
  first_below_floor date,
  min_closing_cents bigint,
  primary key (workspace_id, user_id)
);

create table categorization_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  pattern text not null, -- texto normalizado contido na descrição
  category_id uuid not null references categories(id) on delete cascade,
  hits int not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, pattern)
);

create table budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  alert_pct int not null default 100 check (alert_pct between 1 and 200),
  created_at timestamptz not null default now(),
  unique (workspace_id, category_id)
);

create table goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null default 'other' check (kind in ('emergency', 'travel', 'purchase', 'other')),
  target_cents bigint not null check (target_cents > 0),
  saved_cents bigint not null default 0,
  monthly_contribution_cents bigint not null default 0 check (monthly_contribution_cents >= 0),
  start_month date not null default date_trunc('month', current_date)::date,
  target_date date,
  status text not null default 'active' check (status in ('active', 'done', 'cancelled')),
  created_at timestamptz not null default now()
);

-- Fluxos planejados não vindos de recorrências (proventos previstos, vencimentos de renda fixa).
create table planned_cashflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  direction text not null check (direction in ('in', 'out')),
  source text not null check (source in ('dividend', 'fixed_income', 'manual')),
  ref_id uuid,
  description text not null default '',
  created_at timestamptz not null default now()
);
create index on planned_cashflows (workspace_id, date);

-- Uso do LLM para custo por workspace
create table llm_usage (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id text references auth_user(id) on delete set null,
  provider text not null,
  model text not null,
  purpose text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cost_micro_usd bigint not null default 0,
  latency_ms int,
  at timestamptz not null default now()
);
create index on llm_usage (workspace_id, at);

-- migrate:down
drop table if exists llm_usage, planned_cashflows, goals, budgets, categorization_rules, projection_snapshots,
  reminders, reminder_prefs, audit_log, drafts, messages, conversations, pension_entries, pension_plans,
  transactions, recurrences, card_statements, attachments, categories, cards, accounts cascade;
