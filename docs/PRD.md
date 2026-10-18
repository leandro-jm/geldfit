# PRD — App de Planejamento Financeiro com Chat

Oct 11, 2026 · @Leandro

## Visão geral

Um app multiusuário de planejamento financeiro pessoal em que toda ação acontece por chat em linguagem natural, na web e no WhatsApp, com anexos. Não há integração bancária: o usuário informa os dados conversando ou enviando extratos, faturas, boletos e comprovantes, e o agente extrai, confirma e registra.

**Problema.** Quem tem contas em vários bancos (ex.: Banco do Brasil, Cresol, Santander), cartão de crédito e previdência fechada (ex.: Previsc) não tem uma visão única nem uma projeção confiável. Apps de mercado exigem lançamento manual em formulários (abandono alto) ou Open Finance (caro para quem constrói, não cobre previdência fechada).

**Proposta de valor.**

- Registrar qualquer movimentação em uma frase ou uma foto: "paguei 230 de luz no BB ontem", ou o PDF da fatura do cartão.
- Ver mês a mês, por 24 meses, quanto vai entrar, sair e sobrar, já contando parcelas futuras e recorrências.
- Receber no WhatsApp o lembrete do vencimento e o alerta de saldo projetado negativo, e responder ali mesmo.

## Objetivos, não-objetivos e premissas

O MVP vence se o usuário mantém os dados atualizados só conversando, e confia na projeção de 24 meses para decidir gastos.

**Objetivos**

1. Registro de movimentações por linguagem natural (texto e áudio) e por anexo (PDF, imagem, CSV, OFX), com confirmação antes de gravar.
2. Visão consolidada de contas, cartões e previdência por usuário e por workspace.
3. Projeção mensal de 24 meses: entradas, saídas, faturas, saldo projetado, com faixa otimista/pessimista.
4. Lembretes e alertas proativos pelo WhatsApp, com resposta conversacional no mesmo canal.
5. Produto multiusuário desde o início, com isolamento de dados por tenant.

**Não-objetivos (MVP)**

- Integração com bancos ou Open Finance (pode entrar numa fase futura como fonte opcional).
- Pagamentos, Pix ou iniciação de transações. O app registra; não movimenta dinheiro.
- Recomendação individualizada de compra ou venda de ativos específicos: isso é consultoria de valores mobiliários, privativa de consultor registrado na CVM (Resolução CVM 19). Os insights de carteira ficam em diagnóstico e educação (ver Insights e otimização).
- Declaração de IR e contabilidade.

**Premissas**

- O usuário aceita enviar extratos e faturas periodicamente (ex.: uma vez por mês) ou lançar por mensagem.
- Previdência fechada (Previsc) entra por extrato anexado; não há API disponível.
- Valores em BRL, datas em America/Sao\_Paulo; multi-moeda fica fora do MVP.

## Personas e escopo multiusuário

A unidade de dados é o **workspace** (uma família ou uma pessoa); cada usuário pertence a um ou mais workspaces com um papel.

| Persona | Contexto | O que precisa |
| --- | --- | --- |
| Profissional multibanco | 2–4 contas, cartão, previdência fechada | Visão única e projeção sem planilha |
| Casal / família | Contas separadas, despesas compartilhadas | Workspace compartilhado, saber quem lançou |
| Usuário WhatsApp-first | Pouca paciência com apps | Lançar e consultar só por mensagem |

**Papéis no workspace**

- **Owner**: cobrança, convites, exclusão do workspace.
- **Membro**: lança, consulta e recebe lembretes; vê todas as contas do workspace, exceto as marcadas como privadas.
- **Leitor**: só consulta (ex.: contador, cônjuge que só acompanha).

Cada número de WhatsApp é vinculado a um único usuário, verificado por código. Mensagens de números não vinculados recebem só o convite para cadastro.

## Requisitos funcionais

Prioridade: P0 = MVP, P1 = logo após o MVP, P2 = futuro.

| ID | Requisito | Prioridade |
| --- | --- | --- |
| RF-01 | Chat web com texto, áudio (transcrição) e anexos (PDF, JPG/PNG, CSV, OFX; até 20 MB) | P0 |
| RF-02 | Chat no WhatsApp com as mesmas capacidades do chat web, incluindo áudio e anexos | P0 |
| RF-03 | Cadastro de contas por conversa: banco, tipo (corrente, poupança, investimento), saldo inicial e data | P0 |
| RF-04 | Lançar receita, despesa e transferência entre contas por frase; o agente infere valor, data, conta e categoria e pergunta o que faltar | P0 |
| RF-05 | Cartão de crédito: limite, dia de fechamento e vencimento; compras à vista e parceladas geram parcelas futuras na fatura certa | P0 |
| RF-06 | Importar fatura do cartão (PDF/imagem) e extrato bancário (PDF/CSV/OFX): extrair, deduplicar, mostrar prévia e gravar após confirmação | P0 |
| RF-07 | Recorrências: salário, aluguel, assinaturas, contas fixas; criadas por frase ("todo dia 5 entra 8.500 de salário no BB") ou sugeridas pelo agente ao detectar padrão | P0 |
| RF-08 | Previdência: registrar saldo e contribuições mensais a partir do extrato anexado (ex.: Previsc) e por frase | P0 |
| RF-09 | Projeção mensal de 24 meses por workspace e por conta, consultável por chat e por tela | P0 |
| RF-10 | Lembretes de vencimento (D-3, D-1, D0) e de fatura do cartão pelo WhatsApp | P0 |
| RF-11 | Alerta quando o saldo projetado de qualquer mês ficar negativo ou abaixo de um piso definido pelo usuário | P0 |
| RF-12 | Consultas em linguagem natural: "quanto gastei com mercado em setembro?", "quanto sobra em março?" | P0 |
| RF-13 | Editar e desfazer: "corrige o último lançamento para 250", "apaga a compra da farmácia"; histórico de auditoria | P0 |
| RF-14 | Categorias padrão editáveis e regras de categorização aprendidas com as correções do usuário | P1 |
| RF-15 | Resumo semanal e mensal enviado pelo WhatsApp | P1 |
| RF-16 | Simulações: "e se eu comprar um carro de 60 mil em 24x?" sem gravar | P1 |
| RF-17 | Orçamento por categoria com alerta de estouro | P1 |
| RF-18 | Metas (reserva de emergência, viagem) com aporte mensal na projeção | P2 |
| RF-19 | Fonte opcional via Open Finance (ex.: Meu Pluggy) | P2 |

**Telas web (além do chat)**

- Painel: saldo consolidado, próximos vencimentos, alerta ativo.
- Projeção: gráfico de 24 meses e tabela mês a mês (entradas, saídas, faturas, saldo).
- Lançamentos: lista filtrável, com edição inline.
- Contas, cartões, recorrências e previdência: cadastro e revisão.
- Configurações: membros, WhatsApp vinculado, horários de lembrete, piso de saldo.

## Agente conversacional

O agente é um LLM com tool calling sobre um conjunto fechado de tools; ele nunca escreve no banco diretamente e toda escrita passa por prévia e confirmação.

**Pipeline de uma mensagem**

1. Normalizar a entrada: texto; áudio → transcrição; anexo → armazenamento + extração (OCR/parse) para JSON estruturado.
2. Montar contexto: contas, cartões, categorias e recorrências do workspace, últimas N mensagens e data atual.
3. O LLM escolhe tools de leitura livremente e tools de escrita no modo **draft**.
4. O backend valida o draft (schema, conta existe, valor > 0, duplicidade) e devolve uma prévia.
5. O usuário confirma ("sim", botão, ou edita) → commit transacional + registro de auditoria.
6. Resposta curta com o efeito na projeção quando relevante ("março passa a fechar em -320").

**Tools**

| Tool | Tipo | Faz |
| --- | --- | --- |
| `list_accounts`, `list_cards`, `list_categories` | leitura | Contexto para resolver "no BB", "no Santander" |
| `query_transactions` | leitura | Filtros por período, conta, categoria, texto; agregações |
| `get_projection` | leitura | Projeção por mês, conta ou workspace |
| `simulate` | leitura | Projeção com eventos hipotéticos, sem gravar |
| `draft_transactions` | escrita (draft) | Um ou vários lançamentos, incluindo parcelados |
| `draft_recurrence` | escrita (draft) | Criar ou alterar recorrência |
| `draft_account` / `draft_card` | escrita (draft) | Criar ou alterar conta ou cartão |
| `draft_pension_entry` | escrita (draft) | Saldo e contribuição de previdência |
| `draft_edit` / `draft_delete` | escrita (draft) | Corrigir ou remover lançamentos existentes |
| `parse_attachment` | leitura | Retorna o JSON extraído de um anexo para o LLM revisar |
| `set_reminder_prefs` | escrita (draft) | Horários, piso de saldo, canais |
| `commit_draft` | escrita | Só o backend chama, após confirmação do usuário |

**Regras de comportamento**

- Ambiguidade relevante (qual conta, qual cartão, valor ilegível) → uma pergunta objetiva, nunca um palpite gravado.
- Importação em lote (fatura, extrato) → prévia agregada: "38 lançamentos, R$ 4.212,30, 3 possíveis duplicatas"; o usuário confirma tudo ou revisa na web.
- Linguagem do usuário: pt-BR, valores "230", "2,3k", "duzentos e trinta"; datas "ontem", "dia 5", "mês que vem".
- Nenhuma tool executa pagamento ou acessa serviços externos de banco.

**Exemplos**

- "comprei uma TV de 3.600 em 10x no cartão Santander" → prévia: 10 parcelas de R$ 360,00, de nov/2026 a ago/2027, categoria Eletrônicos.
- &#91;PDF da fatura\] "importa essa" → extração, deduplicação contra lançamentos já existentes, prévia em lote.
- "quanto sobra em dezembro?" → `get_projection` e resposta com saldo e os três maiores compromissos do mês.
- &#91;foto do extrato Previsc\] → prévia: saldo em 30/09, contribuição participante e patrocinadora do mês.

## Modelo de dados

Postgres com `workspace_id` em toda tabela de domínio e RLS por membership; valores em `bigint` de centavos, nunca float.

| Tabela | Campos principais | Observação |
| --- | --- | --- |
| `workspaces` | id, name, plan, created\_at | Tenant |
| `memberships` | workspace\_id, user\_id, role | owner, member, viewer |
| `user_channels` | user\_id, kind, address, verified\_at | WhatsApp vinculado |
| `accounts` | id, workspace\_id, institution, type, name, opening\_balance\_cents, opening\_date, is\_private | Conta corrente, poupança, investimento |
| `cards` | id, workspace\_id, account\_id, name, limit\_cents, closing\_day, due\_day | `account_id` = conta que paga a fatura |
| `categories` | id, workspace\_id, name, kind, parent\_id | receita / despesa |
| `transactions` | id, workspace\_id, account\_id, card\_id, date, amount\_cents, direction, category\_id, description, status, source, attachment\_id, installment\_group\_id, installment\_n, installment\_total, dedupe\_hash, created\_by | status: posted, scheduled; source: chat, import, recurrence |
| `card_statements` | id, card\_id, ref\_month, closing\_date, due\_date, total\_cents, status | Fatura derivada das transações do cartão |
| `recurrences` | id, workspace\_id, account\_id/card\_id, amount\_cents, direction, category\_id, rule (RRULE), start\_date, end\_date, amount\_mode | amount\_mode: fixed, average\_n\_months |
| `pension_plans` | id, workspace\_id, provider, name | ex.: Previsc |
| `pension_entries` | id, plan\_id, ref\_month, balance\_cents, contrib\_participant\_cents, contrib\_sponsor\_cents, attachment\_id | Saldo + contribuições |
| `attachments` | id, workspace\_id, storage\_path, mime, sha256, extracted\_json, status | Original + extração |
| `conversations` / `messages` | id, workspace\_id, user\_id, channel, role, content, tool\_calls | Histórico do chat |
| `drafts` | id, workspace\_id, created\_by, kind, payload, expires\_at, status | Escritas pendentes de confirmação |
| `reminders` | id, workspace\_id, user\_id, kind, target\_id, fire\_at, sent\_at | Fila de lembretes |
| `audit_log` | id, workspace\_id, actor\_id, action, before, after, at | Todo commit e edição |

**Regras**

- Transferência entre contas = duas transações ligadas por `transfer_id`; não entra como receita nem despesa.
- Pagamento de fatura = saída da conta pagadora ligada ao `card_statements`; as compras do cartão já contaram como despesa.
- `dedupe_hash` = hash(conta ou cartão, data, valor, descrição normalizada) para importações repetidas.

## Motor de projeção (24 meses)

A projeção é determinística e calculada no banco: compromissos conhecidos mais estimativa de gasto variável, mês a mês, a partir do saldo real de hoje.

**Componentes de cada mês m**

1. **Saldo inicial**: saldo real atual (m = mês corrente) ou saldo final de m−1.
2. **Entradas conhecidas**: recorrências de receita + transações agendadas.
3. **Saídas conhecidas**: recorrências de despesa + agendadas + faturas do cartão com vencimento em m (parcelas já lançadas, alocadas pelo dia de fechamento).
4. **Variável estimado**: média móvel dos últimos 3 meses (configurável 3–6) do gasto sem recorrência e sem parcela, por categoria; meses com menos de 2 meses de histórico usam valor informado pelo usuário.
5. **Previdência**: contribuição do participante como saída, se debitada em conta; o saldo da previdência é exibido à parte e não entra no saldo disponível.

```latex
S_m = S_{m-1} + E_m - D_m - F_m - V_m
```

E = entradas conhecidas, D = despesas conhecidas fora do cartão, F = faturas que vencem no mês, V = variável estimado.

**Faixa de incerteza**: otimista usa V × 0,85 e pessimista V × 1,15 mais o maior gasto variável único dos últimos 6 meses; os fatores são configuráveis por workspace.

**Saída**: por mês, entradas, saídas conhecidas, faturas, variável, saldo projetado (base, otimista, pessimista) e o primeiro mês abaixo do piso.

**Implementação**: função SQL `project(workspace_id, months)` gerando série com `generate_series`; resultado em cache numa tabela `projection_snapshots`, recalculada a cada commit relevante (trigger + fila) e diariamente às 05:00.

**Critérios de aceite**

- [ ] Compra de 3.600 em 10x lançada em 11/10 com fechamento dia 5 aparece em 10 faturas, de nov/2026 (fatura que fecha em 05/11) a ago/2027.
- [ ] Recorrência de salário no dia 5 entra nos 24 meses, até `end_date` se houver.
- [ ] Excluir uma transação recalcula a projeção em menos de 2 s.
- [ ] Projeção bate com o cálculo manual de uma planilha de referência em 3 cenários de teste.

## Canal WhatsApp e lembretes

Como é produto multiusuário, o canal é a WhatsApp Business Cloud API oficial; APIs não oficiais ficam só para desenvolvimento local.

**Comportamento**

- Mensagens do usuário (texto, áudio, documento, imagem) entram por webhook e seguem o mesmo pipeline do chat web.
- Confirmações de draft usam botões interativos (Confirmar, Editar, Cancelar) dentro da janela de 24 h.
- Fora da janela de 24 h, só mensagens por template aprovado: lembrete de vencimento, fatura do cartão, alerta de saldo projetado, resumo semanal.
- Lembrete é acionável: "Conta de luz R$ 230 vence amanhã. Já pagou?" → "sim" marca como paga e registra a saída.

**Lembretes padrão (configuráveis)**

| Evento | Quando | Template |
| --- | --- | --- |
| Conta ou recorrência a vencer | D-3 e D0, 09:00 | `lembrete_vencimento` |
| Fatura do cartão fechou | No dia do fechamento | `fatura_fechada` |
| Fatura a vencer | D-2, 09:00 | `fatura_vencimento` |
| Saldo projetado abaixo do piso | Ao detectar, no máximo 1 por dia | `alerta_saldo` |
| Resumo semanal | Domingo, 19:00 | `resumo_semanal` |
| Lembrete de importar extrato | Dia 2 de cada mês | `lembrete_importacao` |

**Regras**

- Horário silencioso padrão 21:00–08:00; mensagens são adiadas.
- Opt-out por tipo de lembrete, em qualquer mensagem ("para de mandar resumo").
- Custo das mensagens de template é repassado no plano; estimativa por usuário ativo entra na seção de custos.

## Insights e otimização

O app diagnostica a carteira que o usuário informou (dólar, fundos, ações, renda fixa, previdência) com regras transparentes e explica em linguagem natural; ele não diz "compre X" ou "venda Y".

**Limite regulatório.** Orientação individualizada sobre classes de ativos ou valores mobiliários específicos é consultoria de valores mobiliários, atividade privativa de consultor registrado na CVM ([Resolução CVM 19](https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/resolucoes/anexos/001/resol019consolid.pdf)). Por isso os insights comparam a carteira com metas que o próprio usuário define, mostram fatos e custos, e educam; o texto final passa por revisão jurídica antes do beta.

**Entrada da carteira (sem integração bancária)**

- Frase: "comprei 100 ITUB4 a 32,50 na XP", "comprei 2.000 dólares a 5,42".
- Anexo: nota de corretagem, extrato de posição da corretora, extrato de custódia da B3, extrato de fundo, extrato da previdência.
- O agente gera drafts de operações (compra, venda, aporte, resgate, provento); posição e preço médio são calculados a partir delas.

**Dados de mercado (públicos, não bancários)**

| Dado | Fonte | Uso |
| --- | --- | --- |
| Ações, FIIs, ETFs, BDRs, proventos, câmbio | [brapi.dev](https://brapi.dev/faq/api-e-gratis-mesmo) (gratuito até 15.000 requisições/mês; plano pago para produção) | Cotação diária, histórico, calendário de proventos |
| Dólar PTAX, CDI, Selic, IPCA | Banco Central (séries SGS e PTAX) | Benchmarks e conversão USD/BRL |
| Cota diária de fundos | CVM, dados abertos (informe diário) | Rentabilidade de fundos por CNPJ |

Cotações são buscadas uma vez por dia por ativo distinto em toda a base (não por usuário), o que mantém o custo baixo.

**Catálogo de insights (MVP)**

| Insight | Regra | Exemplo de mensagem |
| --- | --- | --- |
| Exposição ao dólar | % do patrimônio em USD (dólar, BDR, ETF internacional) fora da faixa-alvo do usuário | "Sua exposição ao dólar está em 4%; sua meta é 10–15%." |
| Custo do dólar | Preço médio das compras de USD vs PTAX atual | "Preço médio 5,31; PTAX hoje 5,47." |
| Concentração | Um ativo > 20% da renda variável, ou um setor > 35% | "ITUB4 é 31% das suas ações." |
| Fundo caro | Fundo DI ou RF com rendimento 12m < 95% do CDI, ou taxa de administração > 1% a.a. | "Este fundo rendeu 88% do CDI em 12 meses, com taxa de 1,5% a.a." |
| Desempenho | Carteira e cada classe vs CDI, IBOV e IPCA no mês, 12m e desde o início | "Ações: +6,2% em 12m; IBOV: +9,1%." |
| Dinheiro parado | Saldo em conta corrente acima de 1 mês de despesas projetadas por mais de 30 dias | "R$ 18.400 parados no BB há 45 dias." |
| Reserva de emergência | Meses de despesa cobertos por ativos com liquidez diária vs meta do usuário | "Reserva cobre 2,1 meses; sua meta é 6." |
| Rebalanceamento | Classe com desvio > 5 p.p. da alocação-alvo definida pelo usuário | "Renda variável está 8 p.p. acima do seu alvo." |
| Proventos | Dividendos e JCP previstos | Entram como entradas na projeção de 24 meses |
| Calendário fiscal | Come-cotas (maio e novembro); vendas de ações no mês vs limite de isenção vigente, parametrizado | "Vendas de ações no mês: R$ 17.800; limite de isenção configurado: R$ 20.000." |

Cada insight mostra a regra, os números usados e a data da cotação; o usuário pode silenciar um tipo de insight.

**Integração com o resto do app**

- Proventos previstos, vencimentos de renda fixa e aportes programados entram na projeção.
- Insights novos aparecem no dashboard e, se o usuário quiser, no resumo semanal do WhatsApp.
- Perguntas no chat: "quanto tenho em dólar?", "qual fundo está pior que o CDI?", "como está minha carteira vs IBOV no ano?".

**Modelo de dados adicional**

| Tabela | Campos principais |
| --- | --- |
| `assets` | id, kind (stock, fii, etf, bdr, fund, fixed\_income, cash\_usd, pension), ticker ou cnpj, name, currency, sector |
| `trades` | id, workspace\_id, asset\_id, broker, date, kind (buy, sell, dividend, jcp, contribution, redemption), qty, price\_cents, fees\_cents, fx\_rate, attachment\_id |
| `positions` (view) | asset\_id, qty, avg\_price\_cents, market\_value\_cents, weight |
| `asset_prices` | asset\_id, date, close\_cents, source |
| `fx_rates` / `benchmarks` | date, series (PTAX, CDI, SELIC, IPCA, IBOV), value |
| `allocation_targets` | workspace\_id, asset\_class, min\_pct, max\_pct, emergency\_months |
| `insights` | id, workspace\_id, rule, severity, payload, created\_at, dismissed\_at |

**Agente**: novas tools `get_portfolio`, `get_insights`, `draft_trade`, `set_allocation_targets`. O prompt de sistema e um filtro de saída bloqueiam recomendação de compra ou venda de ativo específico; perguntas desse tipo recebem os fatos da carteira e o aviso de que o app não faz recomendação.

**Critérios de aceite**

- [ ] Importar uma nota de corretagem com 5 operações gera 5 drafts com taxas e preço médio corretos.
- [ ] Posição em USD é convertida pela PTAX do último dia útil, com a data exibida.
- [ ] Nenhuma resposta do agente, em 200 prompts adversariais, recomenda comprar ou vender um ticker específico.

## Dashboard

O dashboard responde em uma tela quanto o usuário tem, quanto deve e quanto sobra nos próximos 24 meses; todo número abre o detalhe e pode virar pergunta no chat.

&#91;embedded content: wireframe do dashboard · desktop\]

No celular os painéis empilham em uma coluna na mesma ordem, com a barra de chat fixa no rodapé.

**Painéis**

| Painel | Mostra | Visualização | Drill-down |
| --- | --- | --- | --- |
| KPIs | Patrimônio total, saldo em contas, faturas abertas, menor saldo projetado em 24 meses | Cartões com variação vs mês anterior | Lista de contas, faturas, mês crítico |
| Projeção de 24 meses | Saldo base, faixa otimista e pessimista, piso, meses abaixo do piso destacados | Linha com faixa + linha de piso | Tabela do mês: entradas, saídas, faturas, variável |
| Insights | Insights ativos por severidade | Lista com indicador | Regra, números usados, data da cotação |
| Receitas x despesas | 12 meses realizados + 3 projetados | Barras agrupadas | Lançamentos do mês |
| Despesas por categoria | Mês atual vs média de 3 meses | Barras horizontais ordenadas | Lançamentos da categoria |
| Alocação vs alvo | % por classe vs faixa-alvo do usuário | Rosca + desvio em p.p. | Posições da classe |
| Exposição ao dólar | % em USD vs faixa-alvo, preço médio vs PTAX | Barra com faixa-alvo | Operações em USD |
| Desempenho | Carteira vs CDI e IBOV (mês, 12m, início) | Linhas em base 100 | Desempenho por ativo |
| Próximos vencimentos | Contas, faturas e recorrências dos próximos 15 dias | Lista com data e valor | Marcar como pago |
| Cartões | Limite usado, fatura atual, parcelas futuras | Barras de uso | Fatura e parcelas por mês |
| Previdência | Saldo e contribuições (participante e patrocinadora) | Linha mensal | Extratos importados |

**Interações**

- Filtros globais: workspace, período, contas, moeda de exibição (BRL ou USD pela PTAX).
- "Perguntar sobre isto" em cada painel abre o chat com o contexto do painel (ex.: "por que março fica abaixo do piso?").
- Toda métrica mostra a data da última atualização dos dados que a compõem; contas sem lançamento há mais de 30 dias aparecem sinalizadas.
- Modo privacidade: oculta valores com um toque.

**Implementação**

- Métricas servidas por views e funções SQL (`dashboard_summary`, `project`, `portfolio_metrics`) com RLS; o frontend só renderiza.
- Gráficos com uma biblioteca React (ex.: ECharts ou Recharts); a mesma série de dados alimenta o painel e a resposta do chat.
- Meta: dashboard carregado em menos de 1,5 s (p95) com 2 anos de dados.

**Critérios de aceite**

- [ ] Somatório dos KPIs bate com a soma das contas, cartões e posições na data.
- [ ] Mudar um lançamento pelo chat atualiza o dashboard aberto em até 5 s.
- [ ] Layout legível em 360 px de largura sem rolagem horizontal.

## Requisitos não funcionais

Dados financeiros são dados pessoais sob a LGPD: isolamento por tenant, minimização do que vai ao LLM e exclusão real são requisitos de MVP.

**Segurança e isolamento**

- RLS em todas as tabelas de domínio por `workspace_id` + membership; testes automatizados tentando leitura cruzada entre tenants.
- Tools do agente recebem `workspace_id` do contexto autenticado, nunca do texto do LLM.
- Anexos em bucket privado, URLs assinadas de curta duração; criptografia em repouso.
- Webhook do WhatsApp validado por assinatura; número vinculado verificado por código.
- Conteúdo de anexos é tratado como dado: instruções dentro de um PDF não viram comandos (defesa contra prompt injection).

**LGPD**

- Consentimento explícito no cadastro; finalidade declarada.
- Exportação dos dados do usuário (JSON/CSV) e exclusão de workspace com expurgo de anexos em até 30 dias.
- Provedor de LLM com contrato de não retenção e não uso para treino; registrar sub-operadores.
- Nenhum número de cartão completo, senha ou CPF é armazenado; a extração mascara para os 4 últimos dígitos.

**Desempenho e confiabilidade**

| Métrica | Meta |
| --- | --- |
| Resposta a lançamento simples (p95) | < 4 s |
| Importação de fatura de 50 itens até a prévia (p95) | < 30 s |
| Recalcular projeção de 24 meses | < 2 s |
| Lembrete disparado no horário | ≥ 99% em até 5 min |
| Disponibilidade mensal | 99,5% |

**Custo de LLM**

- Modelo pequeno para classificar intenção e extrair lançamentos simples; modelo maior só para importação de documentos e consultas analíticas.
- Prompt caching do contexto do workspace; limite de mensagens e páginas importadas por plano.

## Arquitetura técnica e stack

Web e WhatsApp entram no mesmo orquestrador; ele é o único que fala com o LLM e o único que grava no banco, sempre via draft confirmado.

&#91;embedded content: arquitetura · 2 canais, 1 orquestrador, Supabase\]

O worker agendado dispara lembretes e recalcula a projeção sem passar pelo LLM.

| Camada | Escolha | Motivo |
| --- | --- | --- |
| Frontend web | React + TypeScript (Vite), PWA | Chat + telas de projeção; instalável no celular |
| Backend | Supabase Edge Functions ou serviço Node em container | Orquestrador, webhooks, tools |
| Banco | Supabase Postgres com RLS | Multi-tenant por `workspace_id`; projeção em SQL |
| Auth | Supabase Auth (e-mail, Google) | Simples para B2C; Keycloak só se houver SSO corporativo |
| Arquivos | Supabase Storage | Anexos originais, bucket privado |
| Fila e agendamento | `pg_cron` + `pgmq` ou worker Node | Lembretes, recálculo diário, processamento de anexos |
| LLM | Provedor com tool calling e contrato de não retenção | Roteamento entre modelo pequeno e grande |
| Extração | LLM com visão para PDF/imagem; parsers para CSV e OFX | OFX e CSV não precisam de LLM |
| WhatsApp | WhatsApp Business Cloud API (Meta) | Oficial, exigido para produto multiusuário |
| Deploy | Docker + Portainer em VPS no MVP; gerenciado depois | Custo baixo no início |
| Observabilidade | Logs estruturados, rastreio de cada tool call, custo por workspace | Depurar o agente e controlar margem |

## Métricas de sucesso

A métrica-norte é a proporção de usuários que mantêm os dados atualizados: sem isso, a projeção não tem valor.

| Métrica | Definição | Meta (90 dias após lançamento) |
| --- | --- | --- |
| Usuários atualizados | % de ativos com lançamento ou importação nos últimos 7 dias | ≥ 60% |
| Retenção D30 | % de novos usuários ativos no dia 30 | ≥ 40% |
| Precisão da extração | % de itens de fatura/extrato aceitos sem edição | ≥ 95% |
| Confirmação sem edição | % de drafts do chat confirmados sem correção | ≥ 85% |
| Erro da projeção | Diferença entre saldo projetado (m+1) e saldo real no fim do mês | ≤ 10% |
| Lembretes acionados | % de lembretes de vencimento respondidos ou marcados como pagos | ≥ 50% |
| Canal | % de mensagens vindas do WhatsApp | Acompanhar, sem meta |

## Roadmap por fases

O chat web vem primeiro porque é onde a extração e a projeção são validadas com custo baixo; o WhatsApp entra quando os templates estiverem aprovados e a extração atingir 90% de aceite sem edição.

&#91;embedded content: roadmap · 4 fases, 3 gates\]

Cada diamante é um gate: a fase seguinte só começa com o critério abaixo dele cumprido. O dashboard básico (KPIs, projeção, vencimentos) entra na Fase 1; carteira, insights e os painéis de investimento entram na Fase 3, depois da revisão jurídica dos textos de insight. Depois do beta: metas (RF-18) e Open Finance como fonte opcional (RF-19). Os templates do WhatsApp devem ser submetidos à Meta já na Fase 1, para não travar a Fase 2.

## Riscos e questões em aberto

O maior risco é o usuário parar de alimentar o app; o segundo é a extração de documentos errar sem que ele perceba.

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Usuário deixa de lançar e importar | Projeção perde valor e ele abandona | Lembrete mensal de importação; lançar por áudio; mostrar "última atualização" por conta |
| Extração erra valores ou datas | Projeção errada sem o usuário notar | Prévia obrigatória; checagem de total extraído contra total da fatura; destaque de baixa confiança |
| Layouts de fatura e extrato variam por banco | Precisão baixa em bancos menores (ex.: cooperativas) | Conjunto de testes por instituição; fallback para CSV/OFX; correção alimenta exemplos |
| LLM grava ação errada | Dado corrompido | Escrita só por draft + confirmação; desfazer; auditoria |
| Prompt injection via anexo | Ação não pedida | Conteúdo de anexo nunca vira instrução; tools com escopo do tenant autenticado |
| Custo de LLM e de templates WhatsApp por usuário | Margem negativa no plano gratuito | Roteamento de modelos; limites por plano; resumo semanal opcional |
| Template do WhatsApp rejeitado pela Meta | Lembretes atrasam no lançamento | Submeter templates na fase 1; e-mail como fallback |

**Questões em aberto**

- [ ] Nome do produto e domínio.
- [ ] Modelo de cobrança: freemium com limite de importações, ou plano pago único?
- [ ] Provedor de LLM e de transcrição de áudio (custo vs precisão em pt-BR).
- [ ] Cartões adicionais de terceiros entram como membro do workspace ou como tag?
- [ ] Contas privadas dentro de workspace compartilhado entram na projeção consolidada?
- [x] Previdência: exibir projeção de saldo futuro (P2) ou só histórico no MVP? Resolvido: cenário de aposentadoria em `/previdencia` e no chat (`retirement_scenario`), em reais de hoje, com renda constante até a idade final e o quanto falta frente ao gasto atual.
