-- migrate:up

-- Reserva um número de WhatsApp para o usuário corrente com código de verificação. Falha se o
-- número já estiver verificado por outra pessoa (cada número pertence a um único usuário).
create or replace function claim_whatsapp(p_address text, p_code_hash text, p_expires timestamptz, p_ws uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_uid text := app_uid(); v_row user_channels%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not is_member(p_ws) then raise exception 'not a member' using errcode = '42501'; end if;
  select * into v_row from user_channels where kind = 'whatsapp' and address = p_address for update;
  if found and v_row.user_id <> v_uid and v_row.verified_at is not null then
    raise exception 'address already linked' using errcode = '23505';
  end if;
  delete from user_channels where kind = 'whatsapp' and user_id = v_uid and address <> p_address;
  insert into user_channels (user_id, kind, address, verification_code_hash, code_expires_at, verified_at, default_workspace_id)
  values (v_uid, 'whatsapp', p_address, p_code_hash, p_expires, null, p_ws)
  on conflict (kind, address) do update set user_id = v_uid, verification_code_hash = excluded.verification_code_hash,
    code_expires_at = excluded.code_expires_at, verified_at = null, default_workspace_id = excluded.default_workspace_id;
end $$;

grant execute on function claim_whatsapp(text, text, timestamptz, uuid) to app_user;

-- migrate:down
drop function if exists claim_whatsapp(text, text, timestamptz, uuid);
