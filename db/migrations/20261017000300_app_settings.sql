-- migrate:up

-- Configurações globais da instância editáveis pela tela (hoje: chaves e modelos de IA).
-- Não pertence a um workspace: quem edita é o admin (ADMIN_EMAILS), checado na API.
-- Segredos ficam cifrados pela aplicação (AES-256-GCM com FILES_ENCRYPTION_KEY).
create table app_settings (
  key text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'), -- nome da variável (ex.: ANTHROPIC_API_KEY)
  value text not null check (length(value) <= 2000),
  secret boolean not null default false,
  updated_by text references auth_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger app_settings_touch before update on app_settings
  for each row execute function touch_updated_at();

grant select, insert, update, delete on app_settings to app_user, app_worker;

-- migrate:down
drop table app_settings;
