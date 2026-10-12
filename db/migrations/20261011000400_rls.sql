-- migrate:up

-- Visibilidade de contas e cartões privados: só o dono enxerga.
create or replace function account_visible(acc uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from accounts a
  where a.id = acc and is_member(a.workspace_id) and (not a.is_private or a.owner_user_id = app_uid())
) $$;

create or replace function card_visible(c uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from cards k
  where k.id = c and is_member(k.workspace_id) and (not k.is_private or k.owner_user_id = app_uid())
) $$;

-- Grants base: app_user opera tudo sob RLS; app_worker tem BYPASSRLS.
grant select, insert, update, delete on all tables in schema public to app_user, app_worker;
grant usage, select on all sequences in schema public to app_user, app_worker;
-- Tabelas de mercado: app_user só lê; quem escreve é o worker.
revoke insert, update, delete on asset_prices, benchmarks, asset_events from app_user;

-- ---------------------------------------------------------------------------
-- Política padrão: membro lê; owner/member escrevem.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'attachments', 'pension_plans', 'pension_entries', 'categorization_rules', 'budgets',
    'goals', 'planned_cashflows', 'trades', 'allocation_targets', 'insights', 'insight_mutes', 'workspace_settings'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy member_read on %I for select using (is_member(workspace_id))', t);
    execute format('create policy writer_insert on %I for insert with check (can_write(workspace_id))', t);
    execute format('create policy writer_update on %I for update using (can_write(workspace_id)) with check (can_write(workspace_id))', t);
    execute format('create policy writer_delete on %I for delete using (can_write(workspace_id))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
alter table workspaces enable row level security;
alter table workspaces force row level security;
create policy ws_read on workspaces for select using (is_member(id));
create policy ws_update on workspaces for update using (is_owner(id)) with check (is_owner(id));
create policy ws_delete on workspaces for delete using (is_owner(id));
-- insert só via create_workspace() (security definer)

alter table memberships enable row level security;
alter table memberships force row level security;
create policy mem_read on memberships for select using (is_member(workspace_id));
create policy mem_owner_write on memberships for all using (is_owner(workspace_id)) with check (is_owner(workspace_id));
create policy mem_self_leave on memberships for delete using (user_id = app_uid());

alter table invites enable row level security;
alter table invites force row level security;
create policy inv_owner on invites for all using (is_owner(workspace_id)) with check (is_owner(workspace_id));

alter table user_channels enable row level security;
alter table user_channels force row level security;
create policy uc_self on user_channels for all using (user_id = app_uid()) with check (user_id = app_uid());

alter table consents enable row level security;
alter table consents force row level security;
create policy consent_self on consents for all using (user_id = app_uid()) with check (user_id = app_uid());

-- ---------------------------------------------------------------------------
-- Contas e cartões privados
-- ---------------------------------------------------------------------------
alter table accounts enable row level security;
alter table accounts force row level security;
create policy acc_read on accounts for select
  using (is_member(workspace_id) and (not is_private or owner_user_id = app_uid()));
create policy acc_write on accounts for all
  using (can_write(workspace_id) and (not is_private or owner_user_id = app_uid()))
  with check (can_write(workspace_id) and (not is_private or owner_user_id = app_uid()));

alter table cards enable row level security;
alter table cards force row level security;
create policy card_read on cards for select
  using (is_member(workspace_id) and (not is_private or owner_user_id = app_uid()));
create policy card_write on cards for all
  using (can_write(workspace_id) and (not is_private or owner_user_id = app_uid()))
  with check (can_write(workspace_id) and (not is_private or owner_user_id = app_uid()));

alter table card_statements enable row level security;
alter table card_statements force row level security;
create policy cs_read on card_statements for select using (is_member(workspace_id) and card_visible(card_id));
create policy cs_write on card_statements for all
  using (can_write(workspace_id) and card_visible(card_id))
  with check (can_write(workspace_id) and card_visible(card_id));

-- Transações e recorrências herdam a visibilidade da conta/cartão.
alter table transactions enable row level security;
alter table transactions force row level security;
create policy tx_read on transactions for select using (
  is_member(workspace_id)
  and (account_id is null or account_visible(account_id))
  and (card_id is null or card_visible(card_id))
);
create policy tx_write on transactions for all using (
  can_write(workspace_id)
  and (account_id is null or account_visible(account_id))
  and (card_id is null or card_visible(card_id))
) with check (
  can_write(workspace_id)
  and (account_id is null or account_visible(account_id))
  and (card_id is null or card_visible(card_id))
);

alter table recurrences enable row level security;
alter table recurrences force row level security;
create policy rec_read on recurrences for select using (
  is_member(workspace_id)
  and (account_id is null or account_visible(account_id))
  and (card_id is null or card_visible(card_id))
);
create policy rec_write on recurrences for all using (
  can_write(workspace_id)
  and (account_id is null or account_visible(account_id))
  and (card_id is null or card_visible(card_id))
) with check (
  can_write(workspace_id)
  and (account_id is null or account_visible(account_id))
  and (card_id is null or card_visible(card_id))
);

-- ---------------------------------------------------------------------------
-- Dados pessoais dentro do workspace (conversa, drafts, preferências)
-- ---------------------------------------------------------------------------
alter table conversations enable row level security;
alter table conversations force row level security;
create policy conv_self on conversations for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

alter table messages enable row level security;
alter table messages force row level security;
create policy msg_self on messages for all
  using (is_member(workspace_id) and conversation_id in (select id from conversations))
  with check (is_member(workspace_id) and conversation_id in (select id from conversations));

alter table drafts enable row level security;
alter table drafts force row level security;
create policy draft_self on drafts for all
  using (created_by = app_uid() and is_member(workspace_id))
  with check (created_by = app_uid() and can_write(workspace_id));

alter table reminder_prefs enable row level security;
alter table reminder_prefs force row level security;
create policy rp_self on reminder_prefs for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

alter table reminders enable row level security;
alter table reminders force row level security;
create policy rem_self on reminders for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

alter table projection_snapshots enable row level security;
alter table projection_snapshots force row level security;
create policy ps_self on projection_snapshots for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_read on audit_log for select using (is_member(workspace_id));
create policy audit_insert on audit_log for insert with check (can_write(workspace_id) and actor_id = app_uid());
create policy audit_undo on audit_log for update using (can_write(workspace_id)) with check (can_write(workspace_id));

alter table llm_usage enable row level security;
alter table llm_usage force row level security;
create policy llm_read on llm_usage for select using (is_member(workspace_id));
create policy llm_insert on llm_usage for insert with check (workspace_id is null or is_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Carteira
-- ---------------------------------------------------------------------------
alter table assets enable row level security;
alter table assets force row level security;
create policy asset_read on assets for select using (workspace_id is null or is_member(workspace_id));
create policy asset_write on assets for all
  using (workspace_id is not null and can_write(workspace_id))
  with check (workspace_id is not null and can_write(workspace_id));

-- ---------------------------------------------------------------------------
-- Funções de tenancy (security definer, sempre amarradas a app_uid())
-- ---------------------------------------------------------------------------
create or replace function seed_workspace(ws uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into workspace_settings (workspace_id) values (ws) on conflict do nothing;
  insert into categories (workspace_id, name, kind, icon, is_system)
  select ws, c.name, c.kind, c.icon, true
  from (values
    ('Salário', 'income', 'briefcase'), ('Renda extra', 'income', 'sparkles'), ('Rendimentos', 'income', 'trending-up'),
    ('Reembolso', 'income', 'undo-2'), ('Outras receitas', 'income', 'plus-circle'),
    ('Moradia', 'expense', 'home'), ('Aluguel', 'expense', 'key'), ('Energia', 'expense', 'zap'),
    ('Água', 'expense', 'droplet'), ('Internet e telefone', 'expense', 'wifi'), ('Mercado', 'expense', 'shopping-cart'),
    ('Restaurantes', 'expense', 'utensils'), ('Transporte', 'expense', 'car'), ('Combustível', 'expense', 'fuel'),
    ('Saúde', 'expense', 'heart-pulse'), ('Farmácia', 'expense', 'pill'), ('Educação', 'expense', 'graduation-cap'),
    ('Lazer', 'expense', 'party-popper'), ('Viagem', 'expense', 'plane'), ('Assinaturas', 'expense', 'repeat'),
    ('Vestuário', 'expense', 'shirt'), ('Eletrônicos', 'expense', 'monitor'), ('Pets', 'expense', 'paw-print'),
    ('Impostos e taxas', 'expense', 'landmark'), ('Seguros', 'expense', 'shield'), ('Previdência', 'expense', 'piggy-bank'),
    ('Investimentos', 'expense', 'line-chart'), ('Presentes e doações', 'expense', 'gift'), ('Cuidados pessoais', 'expense', 'scissors'),
    ('Outras despesas', 'expense', 'circle-ellipsis')
  ) as c(name, kind, icon)
  on conflict do nothing;
end $$;

create or replace function create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid text := app_uid();
  v_ws uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into workspaces (name, created_by) values (p_name, v_uid) returning id into v_ws;
  insert into memberships (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
  perform seed_workspace(v_ws);
  return v_ws;
end $$;

create or replace function accept_invite(p_token_hash text) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid text := app_uid();
  v_inv invites%rowtype;
  v_email text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_inv from invites where token_hash = p_token_hash and accepted_at is null and expires_at > now() for update;
  if not found then raise exception 'invite not found or expired' using errcode = 'P0002'; end if;
  select email into v_email from auth_user where id = v_uid;
  if lower(v_email) <> lower(v_inv.email) then raise exception 'invite email mismatch' using errcode = '42501'; end if;
  insert into memberships (workspace_id, user_id, role) values (v_inv.workspace_id, v_uid, v_inv.role)
    on conflict (workspace_id, user_id) do nothing;
  update invites set accepted_at = now() where id = v_inv.id;
  return v_inv.workspace_id;
end $$;

-- Cria ativo público (ticker/CNPJ) se não existir; retorna o id.
create or replace function ensure_public_asset(p_kind text, p_ticker text, p_cnpj text, p_name text, p_currency text, p_international boolean)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if app_uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_ticker is not null then
    select id into v_id from assets where workspace_id is null and ticker = upper(p_ticker);
  elsif p_cnpj is not null then
    select id into v_id from assets where workspace_id is null and cnpj = p_cnpj;
  end if;
  if v_id is null then
    insert into assets (kind, ticker, cnpj, name, currency, is_international)
    values (p_kind, upper(p_ticker), p_cnpj, p_name, coalesce(p_currency, 'BRL'), coalesce(p_international, false))
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Lookup de usuário pelo número de WhatsApp verificado (usado pelo webhook antes de haver contexto).
create or replace function resolve_whatsapp_user(p_address text)
returns table (user_id text, default_workspace_id uuid)
language sql stable security definer set search_path = public
as $$ select uc.user_id, uc.default_workspace_id from user_channels uc
      where uc.kind = 'whatsapp' and uc.address = p_address and uc.verified_at is not null $$;

grant execute on all functions in schema public to app_user, app_worker;
revoke execute on function seed_workspace(uuid) from public, app_user, app_worker;

-- migrate:down
drop function if exists resolve_whatsapp_user(text), ensure_public_asset(text, text, text, text, text, boolean),
  accept_invite(text), create_workspace(text), seed_workspace(uuid), card_visible(uuid), account_visible(uuid) cascade;
