-- migrate:up

-- Sugestões e perguntas proativas do assistente. Detectores determinísticos criam candidatos (com os
-- números em `facts` e o texto já renderizado em `message`); o planejador escolhe o que entregar sem
-- cansar o usuário; a entrega reaproveita a fila `reminders` (kinds 'nudge' e 'question').
create table agent_nudges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]{3,40}$'), -- detector (goal_behind, profile_gap...)
  type text not null check (type in ('nudge', 'question')),
  category text not null, -- meta, orcamento, reserva, sazonal, renda, carteira, memoria, perfil
  fingerprint text not null,
  priority smallint not null default 50 check (priority between 0 and 100),
  title text not null check (length(title) <= 120),
  message text not null check (length(message) <= 1200),
  facts jsonb not null default '{}',
  options jsonb not null default '[]', -- [{id, label, action}] para perguntas
  draft_kind text, -- ação de um toque: draft criado na entrega ou no "ver prévia"
  draft_payload jsonb,
  draft_preview jsonb,
  draft_id uuid references drafts(id) on delete set null,
  status text not null default 'candidate' check (status in (
    'candidate', 'scheduled', 'delivered', 'accepted', 'dismissed', 'snoozed', 'answered', 'expired', 'superseded')),
  scheduled_for timestamptz,
  reminder_id uuid references reminders(id) on delete set null,
  delivered_at timestamptz,
  delivered_channel text check (delivered_channel in ('whatsapp', 'web')),
  conversation_id uuid references conversations(id) on delete set null,
  responded_at timestamptz,
  response jsonb,
  snooze_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agent_nudges_open_fp on agent_nudges (workspace_id, user_id, fingerprint)
  where status in ('candidate', 'scheduled', 'delivered', 'snoozed');
create index on agent_nudges (workspace_id, user_id, status, created_at desc);
create index on agent_nudges (draft_id) where draft_id is not null;
create trigger agent_nudges_touch before update on agent_nudges
  for each row execute function touch_updated_at();
create trigger agent_nudges_notify after insert or update or delete on agent_nudges
  for each row execute function notify_data_changed();

-- "Não quero mais isso": silencia um tipo de sugestão (até uma data ou para sempre)
create table agent_nudge_mutes (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text not null references auth_user(id) on delete cascade,
  kind text not null,
  until timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id, kind)
);

grant select, insert, update, delete on agent_nudges, agent_nudge_mutes to app_user, app_worker;

alter table agent_nudges enable row level security;
alter table agent_nudges force row level security;
create policy nudge_self on agent_nudges for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

alter table agent_nudge_mutes enable row level security;
alter table agent_nudge_mutes force row level security;
create policy nudge_mute_self on agent_nudge_mutes for all
  using (user_id = app_uid() and is_member(workspace_id))
  with check (user_id = app_uid() and is_member(workspace_id));

alter table reminder_prefs drop constraint reminder_prefs_kind_check;
alter table reminder_prefs add constraint reminder_prefs_kind_check
  check (kind in ('due_bill', 'statement_closed', 'statement_due', 'balance_alert', 'weekly_summary', 'monthly_summary',
    'import_reminder', 'budget_alert', 'insights', 'seasonal', 'nudge', 'question'));

-- migrate:down
delete from reminder_prefs where kind in ('nudge', 'question');
alter table reminder_prefs drop constraint reminder_prefs_kind_check;
alter table reminder_prefs add constraint reminder_prefs_kind_check
  check (kind in ('due_bill', 'statement_closed', 'statement_due', 'balance_alert', 'weekly_summary', 'monthly_summary',
    'import_reminder', 'budget_alert', 'insights', 'seasonal'));
drop table if exists agent_nudge_mutes;
drop table if exists agent_nudges;
