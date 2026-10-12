-- migrate:up

create or replace function month_day(p_month date, p_day int) returns date
language sql immutable
as $$ select make_date(extract(year from p_month)::int, extract(month from p_month)::int,
  least(p_day, extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::int)) $$;

-- Em que fatura cai uma compra feita em p_date. Compras no dia do fechamento ou depois
-- vão para a fatura seguinte. Vencimento no mesmo mês do fechamento se due_day > closing_day.
create or replace function statement_dates(p_closing_day int, p_due_day int, p_date date,
  out ref_month date, out closing_date date, out due_date date)
language plpgsql immutable
as $$
declare v_close date := month_day(p_date, p_closing_day);
begin
  if p_date < v_close then
    closing_date := v_close;
  else
    closing_date := month_day((date_trunc('month', p_date) + interval '1 month')::date, p_closing_day);
  end if;
  ref_month := date_trunc('month', closing_date)::date;
  if p_due_day > p_closing_day then
    due_date := month_day(ref_month, p_due_day);
  else
    due_date := month_day((ref_month + interval '1 month')::date, p_due_day);
  end if;
end $$;

create or replace function ensure_card_statement(p_card uuid, p_date date) returns uuid
language plpgsql
as $$
declare
  v_card cards%rowtype;
  v_d record;
  v_id uuid;
begin
  select * into v_card from cards where id = p_card;
  if not found then raise exception 'card % not found', p_card; end if;
  select * into v_d from statement_dates(v_card.closing_day, v_card.due_day, p_date);
  insert into card_statements (workspace_id, card_id, ref_month, closing_date, due_date)
  values (v_card.workspace_id, p_card, v_d.ref_month, v_d.closing_date, v_d.due_date)
  on conflict (card_id, ref_month) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from card_statements where card_id = p_card and ref_month = v_d.ref_month;
  end if;
  return v_id;
end $$;

create or replace function tx_assign_statement() returns trigger
language plpgsql
as $$
begin
  if new.card_id is not null then
    if tg_op = 'INSERT' or new.date is distinct from old.date or new.card_id is distinct from old.card_id
       or new.card_statement_id is null then
      new.card_statement_id := ensure_card_statement(new.card_id, new.date);
    end if;
  else
    new.card_statement_id := null;
  end if;
  return new;
end $$;
create trigger transactions_statement before insert or update on transactions
  for each row execute function tx_assign_statement();

-- Totais das faturas (compras líquidas de estornos, pagamentos, restante)
create or replace view card_statement_totals with (security_invoker = true) as
select
  cs.id, cs.workspace_id, cs.card_id, cs.ref_month, cs.closing_date, cs.due_date, cs.reported_total_cents, cs.status,
  coalesce((select sum(case when t.direction = 'out' then t.amount_cents else -t.amount_cents end)
            from transactions t where t.card_statement_id = cs.id), 0)::bigint as total_cents,
  coalesce((select sum(p.amount_cents) from transactions p
            where p.pays_statement_id = cs.id and p.status = 'posted'), 0)::bigint as paid_cents
from card_statements cs;

-- Saldo real de uma conta numa data. O saldo inicial vale para o fim do dia opening_date;
-- lançamentos daquele mesmo dia só contam se criados depois da conta.
create or replace function account_balance(p_account uuid, p_at date default current_date) returns bigint
language sql stable
as $$
  select a.opening_balance_cents + coalesce(sum(case when t.direction = 'in' then t.amount_cents else -t.amount_cents end), 0)::bigint
  from accounts a
  left join transactions t on t.account_id = a.id and t.status = 'posted' and t.date <= p_at
    and (t.date > a.opening_date or (t.date = a.opening_date and t.created_at > a.created_at))
  where a.id = p_account
  group by a.id, a.opening_balance_cents
$$;

-- Hoje no fuso do workspace
create or replace function ws_today(p_ws uuid) returns date
language sql stable
as $$ select (now() at time zone coalesce((select timezone from workspace_settings where workspace_id = p_ws), 'America/Sao_Paulo'))::date $$;

-- Gasto variável: despesas sem recorrência e sem parcela, nem transferência ou pagamento de fatura.
create or replace function is_variable_expense(t transactions) returns boolean
language sql immutable
as $$ select t.direction = 'out' and t.kind = 'regular' and t.recurrence_id is null and t.installment_group_id is null $$;

-- ---------------------------------------------------------------------------
-- Motor de projeção (24 meses)
--   S_m = S_{m-1} + E_m - D_m - F_m - V_m - G_m
-- E entradas conhecidas, D despesas conhecidas fora do cartão, F faturas que vencem no mês,
-- V variável estimado, G aportes de metas. Respeita RLS (contas privadas de outros ficam de fora).
-- ---------------------------------------------------------------------------
create or replace function project(p_ws uuid, p_months int default 24, p_account uuid default null, p_today date default null)
returns table (
  month date,
  opening_cents bigint,
  income_cents bigint,
  expense_cents bigint,
  card_bills_cents bigint,
  variable_cents bigint,
  goals_cents bigint,
  closing_cents bigint,
  closing_optimistic_cents bigint,
  closing_pessimistic_cents bigint,
  below_floor boolean
)
language plpgsql stable
as $$
declare
  s workspace_settings%rowtype;
  v_today date;
  v_m0 date;
  v_end date;
  v_accts uuid[];
  v_cards uuid[];
  v_s0 bigint;
  v_hist_start date;
  v_hist_months int;
  v_window int;
  v_var bigint := 0;
  v_var_spent bigint := 0;
  v_max_single bigint := 0;
  v_consolidated boolean := p_account is null;
begin
  select * into s from workspace_settings ws where ws.workspace_id = p_ws;
  if not found then
    s.balance_floor_cents := 0; s.variable_window_months := 3; s.variable_monthly_cents := 0;
    s.optimistic_factor := 0.85; s.pessimistic_factor := 1.15;
  end if;
  v_today := coalesce(p_today, ws_today(p_ws));
  v_m0 := date_trunc('month', v_today)::date;
  v_end := (v_m0 + make_interval(months => p_months))::date;

  select coalesce(array_agg(a.id), '{}') into v_accts from accounts a
  where a.workspace_id = p_ws and a.archived_at is null and a.type <> 'investment'
    and (p_account is null or a.id = p_account);

  select coalesce(array_agg(c.id), '{}') into v_cards from cards c
  where c.workspace_id = p_ws and (p_account is null or c.account_id = p_account);

  select coalesce(sum(account_balance(x, v_today)), 0)::bigint into v_s0 from unnest(v_accts) x;

  if v_consolidated then
    select date_trunc('month', min(t.date))::date into v_hist_start from transactions t
    where t.workspace_id = p_ws and t.status = 'posted' and t.date < v_m0;
    v_hist_months := coalesce((extract(year from age(v_m0, v_hist_start)) * 12 + extract(month from age(v_m0, v_hist_start)))::int, 0);

    if v_hist_months < 2 then
      v_var := s.variable_monthly_cents;
    else
      v_window := least(s.variable_window_months, v_hist_months);
      select coalesce(sum(t.amount_cents), 0) / v_window into v_var from transactions t
      where t.workspace_id = p_ws and t.status = 'posted' and is_variable_expense(t)
        and t.date >= (v_m0 - make_interval(months => v_window))::date and t.date < v_m0;
    end if;

    select coalesce(sum(t.amount_cents), 0) into v_var_spent from transactions t
    where t.workspace_id = p_ws and t.status = 'posted' and is_variable_expense(t)
      and t.date >= v_m0 and t.date <= v_today;

    select coalesce(max(t.amount_cents), 0) into v_max_single from transactions t
    where t.workspace_id = p_ws and t.status = 'posted' and is_variable_expense(t)
      and t.date >= (v_m0 - interval '6 months')::date and t.date <= v_today;
  end if;

  return query
  with months as (
    select gs::date as m, row_number() over (order by gs) - 1 as idx
    from generate_series(v_m0, (v_end - interval '1 month')::date, interval '1 month') gs
  ),
  -- Fluxos de conta conhecidos: agendados, futuros, e agendados vencidos (entram no mês corrente)
  known as (
    select case when t.date < v_today then v_m0 else date_trunc('month', t.date)::date end as m,
           sum(case when t.direction = 'in' then t.amount_cents else 0 end) as inc,
           sum(case when t.direction = 'out' then t.amount_cents else 0 end) as exp
    from transactions t
    where t.account_id = any(v_accts)
      and (t.status = 'scheduled' or t.date > v_today)
      and t.kind <> 'card_payment'
      and t.date < v_end
      -- transferência entre contas do escopo não altera o saldo consolidado
      and not (t.kind = 'transfer' and exists (
        select 1 from transactions t2 where t2.transfer_id = t.transfer_id and t2.id <> t.id and t2.account_id = any(v_accts)))
    group by 1
  ),
  planned as (
    select case when p.date < v_today then v_m0 else date_trunc('month', p.date)::date end as m,
           sum(case when p.direction = 'in' then p.amount_cents else 0 end) as inc,
           sum(case when p.direction = 'out' then p.amount_cents else 0 end) as exp
    from planned_cashflows p
    where v_consolidated and p.workspace_id = p_ws and p.date >= v_m0 and p.date < v_end
    group by 1
  ),
  bills as (
    select case when st.due_date < v_today then v_m0 else date_trunc('month', st.due_date)::date end as m,
           sum(greatest(st.total_cents - st.paid_cents, 0)) as amt
    from card_statement_totals st
    where st.card_id = any(v_cards) and st.status <> 'paid' and st.due_date < v_end
      -- faturas vencidas e não pagas entram no mês corrente, mas só as recentes (até 40 dias),
      -- para que faturas antigas sem pagamento registrado não distorçam a projeção
      and st.due_date >= least(v_m0, v_today - 40)
    group by 1
  ),
  goal_months as (
    select mo.m, sum(g.monthly_contribution_cents) as amt
    from months mo
    join goals g on v_consolidated and g.workspace_id = p_ws and g.status = 'active' and g.monthly_contribution_cents > 0
      and mo.m >= date_trunc('month', g.start_month)
      and (g.target_date is null or mo.m <= date_trunc('month', g.target_date))
      -- para quando o alvo for atingido
      and g.saved_cents + g.monthly_contribution_cents * (
            (extract(year from age(mo.m, greatest(v_m0, date_trunc('month', g.start_month)::date))) * 12
             + extract(month from age(mo.m, greatest(v_m0, date_trunc('month', g.start_month)::date))))::bigint
          ) < g.target_cents
    group by mo.m
  ),
  flows as (
    select mo.m, mo.idx,
      (coalesce(k.inc, 0) + coalesce(p.inc, 0))::bigint as inc,
      (coalesce(k.exp, 0) + coalesce(p.exp, 0))::bigint as exp,
      coalesce(b.amt, 0)::bigint as bills,
      (case when not v_consolidated then 0
            when mo.idx = 0 then greatest(v_var - v_var_spent, 0)
            else v_var end)::bigint as var,
      coalesce(gm.amt, 0)::bigint as goals
    from months mo
    left join known k on k.m = mo.m
    left join planned p on p.m = mo.m
    left join bills b on b.m = mo.m
    left join goal_months gm on gm.m = mo.m
  ),
  calc as (
    select f.*,
      f.inc - f.exp - f.bills - f.var - f.goals as net,
      f.inc - f.exp - f.bills - round(f.var * s.optimistic_factor)::bigint - f.goals as net_opt,
      f.inc - f.exp - f.bills
        - (case when v_consolidated then round(f.var * s.pessimistic_factor)::bigint + v_max_single else 0 end)
        - f.goals as net_pes
    from flows f
  ),
  cum as (
    select c.*,
      v_s0 + sum(c.net) over w as close_base,
      v_s0 + sum(c.net_opt) over w as close_opt,
      v_s0 + sum(c.net_pes) over w as close_pes
    from calc c
    window w as (order by c.m rows between unbounded preceding and current row)
  )
  select cum.m, (cum.close_base - cum.net)::bigint, cum.inc, cum.exp, cum.bills, cum.var, cum.goals,
         cum.close_base::bigint, cum.close_opt::bigint, cum.close_pes::bigint,
         cum.close_base < s.balance_floor_cents
  from cum order by cum.m;
end $$;

-- ---------------------------------------------------------------------------
-- Notificações para recálculo de projeção e atualização em tempo real.
-- Payload idêntico na mesma transação é coalescido pelo Postgres.
-- ---------------------------------------------------------------------------
create or replace function notify_data_changed() returns trigger
language plpgsql
as $$
declare v_ws uuid;
begin
  if tg_op = 'DELETE' then v_ws := old.workspace_id; else v_ws := new.workspace_id; end if;
  perform pg_notify('data_changed', json_build_object('ws', v_ws, 'table', tg_table_name)::text);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'cards', 'transactions', 'recurrences', 'card_statements', 'pension_entries', 'goals',
    'planned_cashflows', 'workspace_settings', 'trades', 'insights', 'budgets', 'drafts', 'categories'
  ] loop
    execute format('create trigger %I after insert or update or delete on %I for each row execute function notify_data_changed()',
      t || '_notify', t);
  end loop;
end $$;

grant select on card_statement_totals to app_user, app_worker;
grant execute on all functions in schema public to app_user, app_worker;
revoke execute on function seed_workspace(uuid) from public, app_user, app_worker;

-- migrate:down
do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'cards', 'transactions', 'recurrences', 'card_statements', 'pension_entries', 'goals',
    'planned_cashflows', 'workspace_settings', 'trades', 'insights', 'budgets', 'drafts', 'categories'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_notify', t);
  end loop;
end $$;
drop function if exists notify_data_changed();
drop function if exists project(uuid, int, uuid, date);
drop function if exists is_variable_expense(transactions), ws_today(uuid), account_balance(uuid, date);
drop view if exists card_statement_totals;
drop trigger if exists transactions_statement on transactions;
drop function if exists tx_assign_statement(), ensure_card_statement(uuid, date), statement_dates(int, int, date), month_day(date, int);
