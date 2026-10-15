# Postgres com o script que cria os papéis da aplicação (roda só na primeira inicialização do volume).
FROM postgres:17-alpine
COPY db/init/ /docker-entrypoint-initdb.d/
