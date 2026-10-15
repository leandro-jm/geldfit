-- migrate:up

-- Contas em dólar (Nomad, Wise, Avenue...). Valores da conta (saldo inicial e lançamentos) ficam na
-- moeda da conta; o equivalente em reais usa a PTAX de venda (série PTAX_USD em benchmarks).
alter table accounts add column currency text not null default 'BRL' check (currency in ('BRL', 'USD'));

-- PTAX mais recente até a data; antes da primeira cotação conhecida, usa a mais antiga.
create or replace function usd_brl_rate(p_at date default current_date) returns numeric
language plpgsql stable
as $$
declare v numeric;
begin
  select b.value into v from benchmarks b where b.series = 'PTAX_USD' and b.date <= p_at order by b.date desc limit 1;
  if v is null then
    select b.value into v from benchmarks b where b.series = 'PTAX_USD' order by b.date limit 1;
  end if;
  if v is null then
    raise exception 'Cotação do dólar indisponível';
  end if;
  return v;
end $$;

-- Saldo em reais: conta em dólar é convertida pela PTAX da data (marcação a mercado).
create or replace function account_balance_brl(p_account uuid, p_at date default current_date) returns bigint
language sql stable
as $$
  select case when a.currency = 'USD' then round(account_balance(a.id, p_at) * usd_brl_rate(p_at))::bigint
              else account_balance(a.id, p_at) end
  from accounts a where a.id = p_account
$$;

-- Valor do lançamento em reais, para somas e relatórios não misturarem moedas.
alter table transactions add column amount_brl_cents bigint not null default 0;
alter table transactions disable trigger user;
update transactions set amount_brl_cents = amount_cents;
alter table transactions enable trigger user;

create or replace function set_amount_brl() returns trigger
language plpgsql
as $$
begin
  if new.account_id is not null and (select a.currency from accounts a where a.id = new.account_id) = 'USD' then
    new.amount_brl_cents := round(new.amount_cents * usd_brl_rate(new.date))::bigint;
  else
    new.amount_brl_cents := new.amount_cents;
  end if;
  return new;
end $$;

create trigger transactions_amount_brl before insert or update of amount_cents, date, account_id, card_id
  on transactions for each row execute function set_amount_brl();

-- Reconverte lançamentos em dólar a partir de uma data (chamado pelo worker ao gravar nova PTAX,
-- corrigindo lançamentos de hoje ou futuros que usaram a cotação anterior).
create or replace function refresh_usd_amounts(p_since date) returns int
language plpgsql
as $$
declare n int;
begin
  update transactions t set amount_brl_cents = round(t.amount_cents * usd_brl_rate(t.date))::bigint
  from accounts a
  where a.id = t.account_id and a.currency = 'USD' and t.date >= p_since
    and t.amount_brl_cents <> round(t.amount_cents * usd_brl_rate(t.date))::bigint;
  get diagnostics n = row_count;
  return n;
end $$;

-- Projeção: saldo inicial e fluxos em reais.
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

  select coalesce(sum(account_balance_brl(x, v_today)), 0)::bigint into v_s0 from unnest(v_accts) x;

  if v_consolidated then
    select date_trunc('month', min(t.date))::date into v_hist_start from transactions t
    where t.workspace_id = p_ws and t.status = 'posted' and t.date < v_m0;
    v_hist_months := coalesce((extract(year from age(v_m0, v_hist_start)) * 12 + extract(month from age(v_m0, v_hist_start)))::int, 0);

    if v_hist_months < 2 then
      v_var := s.variable_monthly_cents;
    else
      v_window := least(s.variable_window_months, v_hist_months);
      select coalesce(sum(t.amount_brl_cents), 0) / v_window into v_var from transactions t
      where t.workspace_id = p_ws and t.status = 'posted' and is_variable_expense(t)
        and t.date >= (v_m0 - make_interval(months => v_window))::date and t.date < v_m0;
    end if;

    select coalesce(sum(t.amount_brl_cents), 0) into v_var_spent from transactions t
    where t.workspace_id = p_ws and t.status = 'posted' and is_variable_expense(t)
      and t.date >= v_m0 and t.date <= v_today;

    select coalesce(max(t.amount_brl_cents), 0) into v_max_single from transactions t
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
           sum(case when t.direction = 'in' then t.amount_brl_cents else 0 end) as inc,
           sum(case when t.direction = 'out' then t.amount_brl_cents else 0 end) as exp
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

grant execute on function usd_brl_rate(date), account_balance_brl(uuid, date), refresh_usd_amounts(date) to app_user, app_worker;

-- migrate:down
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

drop function refresh_usd_amounts(date);
drop trigger transactions_amount_brl on transactions;
drop function set_amount_brl();
alter table transactions drop column amount_brl_cents;
drop function account_balance_brl(uuid, date);
drop function usd_brl_rate(date);
alter table accounts drop column currency;
