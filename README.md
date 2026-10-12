# Saúde Financeira

App multiusuário de planejamento financeiro pessoal em que tudo acontece por chat, na web e no WhatsApp. O usuário lança e consulta conversando ou enviando extratos, faturas e notas de corretagem; o agente extrai, mostra uma prévia e só grava depois da confirmação. Especificação completa em [docs/PRD.md](docs/PRD.md).

## Arquitetura

```
apps/web        React + Vite (PWA), Tailwind + shadcn/ui, ECharts, TanStack Query
apps/api        Fastify: Better Auth, orquestrador do agente, REST, SSE, webhook WhatsApp, LGPD
apps/worker     lembretes, recálculo da projeção, recorrências, dados de mercado, insights, expurgo
packages/shared tipos e regras de domínio (dinheiro em centavos, parser pt-BR, faturas)
packages/llm    interface de LLM agnóstica + adaptador Anthropic + provedor fake (regras)
packages/db     Kysely + withUserContext (aplica a RLS do Postgres por usuário)
db/migrations   SQL (dbmate): schema, RLS, motor de projeção em SQL
```

Web e WhatsApp entram no mesmo orquestrador. Ele é o único que fala com o LLM e toda escrita passa por um **draft** com prévia (inclusive o efeito na projeção) e confirmação. O isolamento entre workspaces é feito pela **RLS do Postgres**: a API conecta como `app_user` (sem `BYPASSRLS`) e cada operação roda com `app.user_id` do usuário autenticado.

Decisões que diferem do PRD original:

| PRD | Aqui | Motivo |
| --- | --- | --- |
| Supabase (Postgres, Auth, Storage, Realtime) | Postgres puro, Better Auth, disco local criptografado, SSE com `LISTEN/NOTIFY` | Pedido do produto |
| WhatsApp Business Cloud API | Evolution API (não oficial) atrás da interface `MessagingChannel` | Pedido do produto; trocar por Cloud API é um novo adaptador |
| Áudio (transcrição) | Fora desta versão | Provedor de transcrição em aberto |
| RF-19 Open Finance | Fora | Fase futura no PRD |

## Rodando localmente

Requisitos: Node 22+, pnpm 11, Docker.

```bash
pnpm install
cp .env.example .env            # gere FILES_ENCRYPTION_KEY com: openssl rand -base64 32
docker compose up -d postgres mailpit
pnpm db:migrate
pnpm seed:demo                  # opcional: demo@saudefinanceira.local / demo12345
pnpm dev                        # API :4100, worker e web :5173
```

- Web: http://localhost:5173 (o Vite faz proxy de `/api` para a API).
- E-mails (verificação, convites, lembretes de fallback): Mailpit em http://localhost:8026.
- Sem `ANTHROPIC_API_KEY`, o agente roda em **modo demonstração** (regras determinísticas): entende frases como "paguei 230 de luz no BB ontem", "comprei uma TV de 3.600 em 10x no cartão Santander", "todo dia 5 entra 8.500 de salário no BB", "quanto sobra em dezembro?", "desfaz". Com a chave, usa `LLM_MODEL_SMALL` (padrão `claude-haiku-5-5`) para lançamentos simples e `LLM_MODEL_LARGE` (padrão `claude-opus-5-5`) para anexos, análises e simulações. Nos modelos que aceitam, o fallback server-side por recusa vem habilitado.

### WhatsApp (Evolution API)

```bash
docker compose --profile whatsapp up -d     # Evolution API + Redis
pnpm whatsapp:setup                         # cria a instância, aponta o webhook e salva data/whatsapp-qr.png
```

Escaneie o QR com o WhatsApp do número do app. Cada usuário vincula o próprio número em **Configurações → WhatsApp** (código de 6 dígitos enviado pelo próprio WhatsApp). Números não vinculados recebem só o convite de cadastro. Confirmações de prévias são por resposta numerada (1 Confirmar · 2 Editar · 3 Cancelar) ou "sim"/"não".

A Evolution API é não oficial: há risco de bloqueio do número pela Meta. Para produção em escala, implemente `MessagingChannel` com a Cloud API (templates aprovados e janela de 24 h).

### Dados de mercado

O worker busca uma vez por dia, por ativo distinto em toda a base: CDI, Selic e IPCA (BCB/SGS), PTAX (BCB/Olinda), cotas de fundos (CVM, informe diário) e ações/FIIs/ETFs/BDRs/proventos/IBOV (brapi.dev — defina `BRAPI_TOKEN`; sem ele, IBOV e parte das cotações ficam indisponíveis).

## Testes

```bash
pnpm test        # 145 testes (vitest) num banco separado: saude_financeira_test
pnpm e2e         # Playwright: fluxo de chat, importação, layout 360–1440 px, acessibilidade (axe)
pnpm eval:cvm    # 200 prompts adversariais contra o provedor real (gasta tokens)
```

Os testes cobrem, entre outros, os critérios de aceite do PRD:

- RLS: nenhuma tabela de domínio vaza entre tenants; leitor não grava; conta privada invisível para os outros membros.
- Projeção: compra de 3.600 em 10x em 11/10 com fechamento dia 5 → faturas de nov/2026 a ago/2027; salário dia 5 por 24 meses; 3 cenários comparados com cálculo de planilha; excluir lançamento e recalcular em menos de 2 s.
- Agente: draft → confirmação → auditoria → desfazer; parcelado; recorrência; conciliação de conta recorrente; leitor sem escrita; filtro CVM 19.
- Importação: CSV e OFX (sem LLM), deduplicação na reimportação, nota de corretagem com 5 operações (taxas e preço médio), arquivo criptografado em repouso e URL assinada.
- Worker: lembrete "vence amanhã. Já pagou?" → "sim" registra o pagamento; alerta de piso no máximo 1 por dia; opt-out; expurgo LGPD.

## Deploy (Docker / Portainer)

```bash
docker compose --profile full up -d --build
```

Sobe Postgres, migrations (dbmate), API, worker, web (nginx com proxy de `/api`), Evolution e Mailpit. Nesse modo a web e a API ficam na mesma origem; ajuste no `.env`:

```
PUBLIC_WEB_URL=http://seu-dominio
PUBLIC_API_URL=http://seu-dominio
```

Anexos ficam em `./data/files`, criptografados com AES-256-GCM (`FILES_ENCRYPTION_KEY`). Faça backup da chave junto com o banco: sem ela os arquivos não podem ser lidos.

## LGPD

- Consentimento explícito no primeiro acesso (termos, privacidade e processamento por LLM).
- Exportação em JSON e CSV (Configurações → Dados).
- Exclusão de workspace e de conta: os dados somem na hora para os usuários e o worker expurga banco e anexos (rodada diária às 03:00).
- Números de cartão e CPF são mascarados antes de gravar a extração e antes de enviar ao LLM.
- Conteúdo de anexos é tratado como dado: a extração roda numa chamada separada, sem ferramentas de escrita, com saída validada por schema.

## Questões em aberto (do PRD)

Resolvidas provisoriamente, podem mudar: contas privadas só entram na projeção de quem é dono; previdência mostra só o histórico; cobrança fica no campo `plan` com limites, sem gateway; cartão adicional de terceiro é uma tag no cartão. Ainda em aberto: nome do produto, modelo de cobrança, provedor de transcrição e a revisão jurídica dos textos de insight antes do beta.
