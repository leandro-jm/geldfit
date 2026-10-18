-- migrate:up

-- Inscrições de Web Push: uma por navegador/aparelho. Não pertence a um workspace — o worker
-- escolhe o usuário e manda para todos os aparelhos dele.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references auth_user(id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  device text check (length(device) <= 200),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
create policy ps_self on push_subscriptions for all using (user_id = app_uid()) with check (user_id = app_uid());

grant select, insert, update, delete on push_subscriptions to app_user, app_worker;

-- O endpoint é do navegador, não da pessoa: se outra conta entrar no mesmo navegador e ativar,
-- a inscrição passa para ela (a RLS impediria o upsert sobre a linha alheia).
create or replace function claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_device text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_uid text := app_uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, device)
  values (v_uid, p_endpoint, p_p256dh, p_auth, p_device)
  on conflict (endpoint) do update set user_id = v_uid, p256dh = excluded.p256dh, auth = excluded.auth,
    device = excluded.device, created_at = now(), last_used_at = null;
end $$;

grant execute on function claim_push_subscription(text, text, text, text) to app_user;

-- migrate:down
drop function if exists claim_push_subscription(text, text, text, text);
drop table push_subscriptions;
