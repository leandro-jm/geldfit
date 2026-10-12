-- migrate:up

-- Catálogo de ativos. workspace_id nulo = ativo público (ticker/CNPJ); preenchido = ativo
-- criado pelo usuário (ex.: CDB de um banco específico).
create table assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  kind text not null check (kind in ('stock', 'fii', 'etf', 'bdr', 'fund', 'fixed_income', 'cash_usd', 'pension', 'crypto')),
  ticker text,
  cnpj text,
  name text not null,
  currency text not null default 'BRL' check (currency in ('BRL', 'USD')),
  sector text,
  is_international boolean not null default false,
  admin_fee_pct numeric(6,3), -- taxa de administração a.a. (fundos)
  fund_class text, -- DI, RF, multimercado, ações...
  maturity_date date, -- renda fixa
  liquidity_days int, -- 0 = liquidez diária
  created_at timestamptz not null default now()
);
create unique index assets_ticker_public on assets (ticker) where workspace_id is null and ticker is not null;
create unique index assets_cnpj_public on assets (cnpj) where workspace_id is null and cnpj is not null;
create index on assets (workspace_id);

create table trades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  asset_id uuid not null references assets(id),
  broker text,
  date date not null,
  kind text not null check (kind in ('buy', 'sell', 'dividend', 'jcp', 'contribution', 'redemption', 'split', 'valuation')),
  qty numeric(24,8) not null default 0,
  price_cents bigint not null default 0, -- por unidade, na moeda do ativo
  fees_cents bigint not null default 0,
  total_cents bigint not null, -- valor total da operação em BRL
  fx_rate numeric(12,6), -- BRL por unidade da moeda do ativo
  attachment_id uuid references attachments(id) on delete set null,
  dedupe_hash text,
  created_by text references auth_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on trades (workspace_id, asset_id, date);

create table asset_prices (
  asset_id uuid not null references assets(id) on delete cascade,
  date date not null,
  close_cents bigint not null,
  source text not null,
  primary key (asset_id, date)
);

-- Séries de mercado: PTAX_USD, CDI, SELIC, IPCA, IBOV (diárias ou mensais)
create table benchmarks (
  series text not null,
  date date not null,
  value numeric(20,8) not null,
  source text not null,
  primary key (series, date)
);

-- Proventos anunciados (fonte pública)
create table asset_events (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets(id) on delete cascade,
  kind text not null check (kind in ('dividend', 'jcp', 'income')),
  ex_date date,
  pay_date date not null,
  amount_per_unit_micros bigint not null,
  source text not null,
  unique (asset_id, kind, pay_date, amount_per_unit_micros)
);

create table allocation_targets (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  asset_class text not null check (asset_class in ('fixed_income', 'equities', 'funds', 'usd', 'pension', 'cash', 'crypto')),
  target_pct numeric(5,2) not null check (target_pct between 0 and 100),
  min_pct numeric(5,2),
  max_pct numeric(5,2),
  primary key (workspace_id, asset_class)
);

create table insights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  rule text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  title text not null,
  message text not null,
  payload jsonb not null default '{}', -- números usados, regra, data da cotação
  fingerprint text not null,
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  resolved_at timestamptz
);
create unique index insights_active_fp on insights (workspace_id, fingerprint) where resolved_at is null;

create table insight_mutes (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  rule text not null,
  primary key (workspace_id, rule)
);

-- migrate:down
drop table if exists insight_mutes, insights, allocation_targets, asset_events, benchmarks, asset_prices, trades, assets cascade;
