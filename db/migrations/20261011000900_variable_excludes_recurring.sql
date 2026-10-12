-- migrate:up

-- Gasto variável = despesa comum sem recorrência, sem parcela e fora de categorias cobertas por
-- uma recorrência ativa (ex.: luz lançada à mão quando já existe a recorrência "Conta de luz").
-- Evita contar duas vezes na projeção (recorrência agendada + média do variável).
create or replace function is_variable_expense(t transactions) returns boolean
language sql stable
as $$
  select t.direction = 'out' and t.kind = 'regular' and t.recurrence_id is null and t.installment_group_id is null
    and not exists (
      select 1 from recurrences r
      where r.workspace_id = t.workspace_id and r.direction = 'out' and r.paused_at is null
        and r.category_id is not null and r.category_id = t.category_id)
$$;

-- migrate:down
create or replace function is_variable_expense(t transactions) returns boolean
language sql immutable
as $$ select t.direction = 'out' and t.kind = 'regular' and t.recurrence_id is null and t.installment_group_id is null $$;
