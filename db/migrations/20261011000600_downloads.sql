-- migrate:up

-- Download por URL assinada (HMAC verificado na API) não tem sessão de usuário. Esta função
-- devolve só os metadados do anexo pedido, sem permitir listagem.
create or replace function attachment_for_download(p_id uuid)
returns table (storage_key text, filename text, mime text)
language sql stable security definer set search_path = public
as $$ select storage_key, filename, mime from attachments where id = p_id $$;

grant execute on function attachment_for_download(uuid) to app_user;

-- migrate:down
drop function if exists attachment_for_download(uuid);
