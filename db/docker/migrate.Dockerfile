# dbmate com as migrations embutidas: não depende de bind mount do repositório no servidor.
FROM amacneil/dbmate:2.36
COPY db/migrations/ /db/migrations/
ENV DBMATE_MIGRATIONS_DIR=/db/migrations DBMATE_NO_DUMP_SCHEMA=true
