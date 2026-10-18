-- migrate:up

-- Calendário financeiro: itens anuais (IPVA, IPTU, matrícula, 13º, IRPF, reajustes) aprendidos do
-- histórico. Só entram na projeção depois de confirmados (viram planned_cashflows com source 'seasonal').
create table seasonal_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null, -- chave do catálogo (ipva, iptu...) ou annual:<tokens>
  label text not null,
  kind text not null check (kind in ('expense', 'income', 'adjustment', 'info')),
  direction text check (direction in ('in', 'out')),
  category_id uuid references categories(id) on delete set null,
  match_pattern text, -- itens manuais: trecho da descrição normalizada que identifica o pagamento
  recurrence_id uuid references recurrences(id) on delete cascade, -- reajustes
  schedule jsonb not null default '[]', -- [{month, day, amountCents}]
  -- temporada (ano) de onde a agenda veio; a detecção só reescreve com dados de temporada mais nova,
  -- então a edição do usuário vale até os pagamentos reais do ano seguinte aparecerem
  schedule_year int,
  adjustment_pct numeric(6, 2),
  lead_days int not null default 30 check (lead_days between 7 and 120),
  confidence text not null default 'media' check (confidence in ('alta', 'media', 'estimado')),
  evidence jsonb not null default '[]', -- [{year, totalCents, months, n}]
  status text not null default 'suggested' check (status in ('suggested', 'confirmed', 'dismissed')),
  source text not null default 'detected' check (source in ('detected', 'manual')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);

grant select, insert, update, delete on seasonal_items to app_user, app_worker;

alter table seasonal_items enable row level security;
alter table seasonal_items force row level security;
create policy member_read on seasonal_items for select using (is_member(workspace_id));
create policy writer_insert on seasonal_items for insert with check (can_write(workspace_id));
create policy writer_update on seasonal_items for update using (can_write(workspace_id)) with check (can_write(workspace_id));
create policy writer_delete on seasonal_items for delete using (can_write(workspace_id));

create trigger seasonal_items_notify after insert or update or delete on seasonal_items
  for each row execute function notify_data_changed();

-- Lançamentos que já pagaram um item do calendário (histórico e ocorrência do ano corrente)
alter table transactions add column seasonal_item_id uuid references seasonal_items(id) on delete set null;
create index on transactions (seasonal_item_id) where seasonal_item_id is not null;

alter table planned_cashflows drop constraint planned_cashflows_source_check;
alter table planned_cashflows add constraint planned_cashflows_source_check
  check (source in ('dividend', 'fixed_income', 'manual', 'seasonal'));

alter table reminder_prefs drop constraint reminder_prefs_kind_check;
alter table reminder_prefs add constraint reminder_prefs_kind_check
  check (kind in ('due_bill', 'statement_closed', 'statement_due', 'balance_alert', 'weekly_summary', 'monthly_summary', 'import_reminder', 'budget_alert', 'insights', 'seasonal'));

-- Item confirmado entra na projeção como fluxo explícito; os pagamentos dele saem da média do
-- variável para não contar duas vezes (IPVA em cota única inflaria a média de janeiro a março).
create or replace function is_variable_expense(t transactions) returns boolean
language sql stable
as $$
  select t.direction = 'out' and t.kind = 'regular' and t.recurrence_id is null and t.installment_group_id is null
    and not exists (
      select 1 from recurrences r
      where r.workspace_id = t.workspace_id and r.direction = 'out' and r.paused_at is null
        and r.category_id is not null and r.category_id = t.category_id)
    and not exists (
      select 1 from seasonal_items si where si.id = t.seasonal_item_id and si.status = 'confirmed')
$$;

-- migrate:down
create or replace function is_variable_expense(t transactions) returns boolean
language sql stable
as $$
  select t.direction = 'out' and t.kind = 'regular' and t.recurrence_id is null and t.installment_group_id is null
    and not exists (
      select 1 from recurrences r
      where r.workspace_id = t.workspace_id and r.direction = 'out' and r.paused_at is null
        and r.category_id is not null and r.category_id = t.category_id)
$$;

delete from reminder_prefs where kind = 'seasonal';
alter table reminder_prefs drop constraint reminder_prefs_kind_check;
alter table reminder_prefs add constraint reminder_prefs_kind_check
  check (kind in ('due_bill', 'statement_closed', 'statement_due', 'balance_alert', 'weekly_summary', 'monthly_summary', 'import_reminder', 'budget_alert', 'insights'));

delete from planned_cashflows where source = 'seasonal';
alter table planned_cashflows drop constraint planned_cashflows_source_check;
alter table planned_cashflows add constraint planned_cashflows_source_check
  check (source in ('dividend', 'fixed_income', 'manual'));

alter table transactions drop column seasonal_item_id;
drop table seasonal_items;
