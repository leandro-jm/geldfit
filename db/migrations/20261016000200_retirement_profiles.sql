-- migrate:up

-- Premissas de aposentadoria de cada membro (cenários além dos 24 meses da projeção). Data de
-- nascimento é dado pessoal: só o próprio usuário lê e grava. Taxas são reais (acima da inflação),
-- em fração ao ano (0.04 = 4% a.a.).
create table retirement_profiles (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  birth_date date not null check (birth_date > '1900-01-01'),
  retire_age int not null default 65 check (retire_age between 30 and 90),
  end_age int not null default 90 check (end_age between 50 and 110),
  accumulation_rate numeric(6, 4) not null default 0.04 check (accumulation_rate between -0.05 and 0.2),
  withdrawal_rate numeric(6, 4) not null default 0.03 check (withdrawal_rate between -0.05 and 0.2),
  contribution_growth numeric(6, 4) not null default 0 check (contribution_growth between -0.1 and 0.1),
  inss_monthly_cents bigint check (inss_monthly_cents >= 0),
  target_income_cents bigint check (target_income_cents > 0),
  include_investments boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  check (end_age > retire_age)
);
create trigger retirement_profiles_touch before update on retirement_profiles
  for each row execute function touch_updated_at();

grant select, insert, update, delete on retirement_profiles to app_user, app_worker;

alter table retirement_profiles enable row level security;
alter table retirement_profiles force row level security;
create policy rtp_self_read on retirement_profiles for select
  using (user_id = app_uid() and is_member(workspace_id));
create policy rtp_self_write on retirement_profiles for all
  using (user_id = app_uid() and can_write(workspace_id))
  with check (user_id = app_uid() and can_write(workspace_id));

-- migrate:down
drop table if exists retirement_profiles;
