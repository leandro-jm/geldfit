#!/bin/sh
# Cria os papéis de login usados pela aplicação. As permissões são concedidas nas migrations.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE app_user LOGIN PASSWORD '${APP_USER_PASSWORD}' NOBYPASSRLS;
  CREATE ROLE app_worker LOGIN PASSWORD '${APP_WORKER_PASSWORD}' BYPASSRLS;
  CREATE DATABASE evolution;
SQL
