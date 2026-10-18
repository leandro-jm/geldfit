# Análise de mercado e diferenciais

Oct 16, 2026 · @Leandro

Análise do mercado brasileiro de finanças pessoais por chat e IA: o que os concorrentes oferecem, o que falta, quais diferenciais seguem as tendências (com foco em IA e agentes), que integrações valem a pena e como entrar no mercado. O objetivo do projeto é **uso pessoal e nicho pequeno**, então as recomendações priorizam utilidade e custo próximo de zero, não escala.

Pesquisa feita na web em outubro de 2026. Números de usuários são declarados pelas próprias empresas; dados de fonte única ou não verificados estão marcados. Fontes ao lado de cada afirmação e consolidadas no fim.

## Resumo

1. **Lançar gasto por WhatsApp com texto, áudio e foto virou commodity.** Pelo menos oito produtos fazem isso (Meu Assessor, Jota, Pierre, Grana Smart, ZapGastos, Financinha, Poupa.ai, Porquim), e os bancos entraram: o Pix com IA do Nubank tem 10 milhões de usuários ativos por mês, e Itaú (ia.i), Bradesco (BIA), PicPay e Inter (Seven) têm assistentes. Não dá para competir nisso.
2. **O app já cobre lacunas que ninguém cobre:** projeção de 24 meses com parcelas e recorrências, previdência fechada, prévia com confirmação e desfazer para PDF de fatura, extrato e nota de corretagem (só o Gorila tem algo parecido, e só para corretagem), papéis familiares de verdade e postura explícita sobre CVM 19 e LGPD.
3. **A dor nº 1 do mercado é dado errado:** Open Finance que não sincroniza, duplicatas, saldo divergente, parcelas mal lançadas. A dor nº 2 é cobrança e cancelamento nos bots de WhatsApp. O modelo "documento → prévia → conciliação → confirmação" ataca a dor nº 1 diretamente.
4. **A tendência global é sair de "conversar com o dinheiro" para "agir com confirmação mínima"** (Rocket Money Rowan, Cleo Autopilot, Revolut AIR), com agente proativo, memória editável, cálculo determinístico com o LLM só explicando, e MCP como canal de distribuição.
5. **Para um nicho pessoal, a vantagem é profundidade, privacidade e custo quase zero.** Evitar Open Finance pago, crédito ou antecipação, anúncios e recomendação de ativos.

## 1. Panorama competitivo

### 1.1 Apps tradicionais de controle financeiro

| App | O que é | IA | WhatsApp | Open Finance | Preço | Observações |
| --- | --- | --- | --- | --- | --- | --- |
| **Mobills** (Santander/Toro) | Contas, cartões, orçamento, metas | ML genérico | Só suporte | Sim | Premium R$ 99,90/ano | Diz ter +10 mi de usuários; reclamações de 2026 sem resposta: cartão sem sincronizar há 60+ dias, saldo diferente entre app e web ([RA](https://www.reclameaqui.com.br/mobills-educacao-financeira/problemas-de-sincronizacao-e-funcionalidades-apos-ativacao-do-open-finance-na-conta-premium-mobills_ZUZD-DDnkifO6ofj/)) |
| **Organizze** | Controle manual ou conectado | Categorização, recibo, **conexão com ChatGPT, Claude e Manus** | Não | Sim (3 ou 10 contas) | R$ 29,90–69,90 (anual) ou R$ 39–79 (mensal) | Sem plano grátis desde 2022; Reclame Aqui 8,9 ([planos](https://www.organizze.com.br/planos)) |
| **Minhas Economias** (Valemobi/TradeMap) | Controle financeiro | MCP | Não | Sim | Grátis; Meu Clube R$ 24,90 | Histórico de duplicatas na sincronização e cartão tratado como conta corrente |
| **Guiabolso** | — | — | — | — | — | Comprado pelo PicPay em 2021, fechado em nov/2022 ([Startups](https://startups.com.br/noticias/guiabolso-comprado-pelo-picpay-sera-encerrado-em-novembro/)) |
| **Olivia** | — | — | — | — | — | Comprada pelo Nubank e fechada cerca de 7 meses depois ([Finsiders](https://finsidersbrasil.com.br/noticias-sobre-fintechs/olivia-comprada-pelo-nubank-vai-encerrar-app-no-mes-que-vem)) |
| **Banco do Brasil Minhas Finanças** | Extrato multibanco | Dicas com IA generativa (jun/2025) | — | Sim | Grátis para clientes | 25 mi de usuários únicos ([Mercado&Consumo](https://mercadoeconsumo.com.br/07/06/2025/noticias/banco-do-brasil-usa-ia-para-ajudar-clientes-com-financas-pessoais/)) |

Lição: no Brasil, apps independentes de finanças pessoais tendem a ser comprados e absorvidos por bancos. Controle financeiro sozinho não se paga.

### 1.2 Assistentes que nasceram no WhatsApp

| App | Destaques | Open Finance | Família | Preço | Base declarada | Pontos fracos |
| --- | --- | --- | --- | --- | --- | --- |
| **Meu Assessor** | 6 "agentes" (finanças, agenda, documentos, NFS-e); texto, áudio, foto, PDF; recorrências, parcelas, projeção mensal; área para contador | 114 instituições | Convite por código | 12x R$ 29,90 | 250 mil | 606 reclamações no RA (jan–jun/2026): cancelamento ignorado, fluxo de caixa e parcelas errados ([RA](https://www.reclameaqui.com.br/empresa/meu-assessor/lista-reclamacoes/)) |
| **Jota** | Banco no WhatsApp: Pix por áudio ou foto, boletos, DDA, análise de fatura; versão 2.0 proativa | Sim | Não | Grátis; Pro R$ 30; Max R$ 200 | ~300 mil; captou R$ 150 mi (jun/2026) | Foco em pequenas empresas ([TI Inside](https://tiinside.com.br/29/06/2026/jota-levanta-r150-milhoes-para-construir-agente-financeiro-baseado-em-ia/)) |
| **Pierre** (CloudWalk) | App, web e WhatsApp com "agentes"; alerta de cobrança duplicada, parcelas e assinaturas; **MCP próprio**; vende CDB | 100+ instituições | Não | Grátis (1 banco); Pro R$ 39; Premium R$ 199 | 165 mil | Monetiza vendendo produto financeiro próprio ([Let's Money](https://www.letsmoney.com.br/noticias/cloudwalk-pierre-ia-multiagente-financas-pessoais/)) |
| **Grana Smart** (investida da B3) | Agentes que executam ações (Pix automático para a reserva); 75% das interações no WhatsApp | Sim | ? | A partir de R$ 29 | ~400 mil (grupo) | ([Let's Money](https://www.letsmoney.com.br/noticias/grana-capital-ia-gestao-financeira-open-finance/)) |
| **ZapGastos** | WhatsApp e Telegram; projeção de fim de mês; até 10 pessoas | 114 instituições | Sim | R$ 9,90–39,90 (anual) | 17 mil | 36 reclamações no 1º sem/2026 (cobrança duplicada) ([planos](https://zapgastos.com/planos)) |
| **Financinha** | Simula quanto um parcelamento compromete os próximos meses; alerta de fechamento de fatura | 130 instituições (sincroniza a cada 3h) | Ilimitado | R$ 29,49 (manual); R$ 39,90 (OF) | 38 mil | ([site](https://www.financinha.com.br/)) |
| **Nath** (Me Poupe!) | Copiloto que paga contas quando o usuário responde "SIM" | ? | ? | ? | ? | ([App Store](https://apps.apple.com/app/id6504570293)) |
| Outros | Poupa.ai (R$ 19,83; casal R$ 34,83), Porquim (~R$ 67/ano), Magie (banco no WhatsApp, captou R$ 28 mi), POQT, GranaZen, Zap Real, CofrinhoPro | | | | | Projetos pequenos, poucos dados públicos |

### 1.3 Investimentos e IR

| App | Destaques | Preço | Observações |
| --- | --- | --- | --- |
| **Gorila** | Gorila AI (mar/2026): diagnóstico, rebalanceamento, comparador, com aviso de "não é recomendação". **Boletador** lê nota de corretagem em PDF ou print e mostra tabela para confirmar | Grátis com limite de tokens | **Concorrente mais parecido com o fluxo extrair → prévia → confirmar.** Limitações: só compra e venda, duplica transações, não deixa editar na confirmação ([blog](https://gorila.com.br/blog/boletador-no-gorila-ai-suas-transacoes-no-portfolio-sem-trabalho-manual/)) |
| **Kinvo** (BTG) | Consolidador | Dentro do Empiricus+ | RA 6,2; integração com B3 quebrada; migração para Open Finance perdeu histórico anterior a 2026 ([RA](https://www.reclameaqui.com.br/kinvo/problemas-com-integracoes-e-historico-de-investimentos-na-kinvo-solicitacao-de-estorno_7DCjctLaP6Oz7WBj/)) |
| **Investidor10** | Carteira, sincronização com B3, ajuda no IR | PRO 12x R$ 19,90 | |
| **TradeMap** | Carteira, cotações, Rocket IA, MCP | | |
| **Nu Smart Invest** (15/10/2026) | Nota de 0 a 1000 para a carteira; Open Finance planejado | Grátis | Concorre direto com o diagnóstico de carteira ([Bloomberg Línea](https://www.bloomberglinea.com.br/tech/nubank-lanca-ferramenta-de-ia-que-promete-recomendacoes-neutras-de-investimento/)) |
| **Grana** | IR da bolsa automático pela B3, DARF por Pix | R$ 19,90–39,90 | |
| **myProfit**, **Smartfolio** | Consolidam notas de corretagem, relatórios de bens e direitos | | |

### 1.4 Bancos

| Banco | O que tem | WhatsApp |
| --- | --- | --- |
| Nubank | Pix por texto, áudio ou imagem (10 mi MAU); AI Private Banker (~15 mi de usuários) | Sim (Pix) |
| Itaú ia.i | Saldo, gasto por categoria, Pix, voz e imagem; liberação gradual desde 27/07/2026 | Não, só no app |
| Bradesco BIA | Pix por voz (limite R$ 300), contas e DDA | Sim |
| Inter Seven | Linguagem natural, insights no extrato | Não confirmado |
| C6 Assistant | Gastos de conta e cartão (90 dias) | **Rejeitou** o WhatsApp: "os dados ficam muito expostos" |
| PicPay | Pix, contas, débito automático via PDF, divisão de despesas em grupo; plugin no ChatGPT (ago/2026) | Sim |

Limitação comum: cada banco enxerga só os próprios dados. Nenhum consolida vários bancos, cartão e previdência com projeção longa.

### 1.5 Matriz de recursos

S = sim, P = parcial, N = não, ? = não encontrado.

| Recurso | **Saúde Financeira (hoje)** | Mobills | Organizze | Meu Assessor | Jota | Pierre | ZapGastos | Financinha | Gorila | Bancos |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chat com IA | S | N | P (MCP) | S | S | S | S | S | S (invest.) | S |
| WhatsApp | S (Evolution) | N | N | S | S | S | S | S | N | Nu, Bradesco, PicPay |
| Áudio e foto | S | N | P | S | S | ? | S | S | P | S |
| PDF de fatura ou extrato | S | N | N | S | S | ? | ? | S | N | N |
| PDF de nota de corretagem | S | N | N | N | N | N | N | N | S | N |
| Prévia, confirmação e desfazer | **S** (draft + auditoria + undo) | P | N | ? | P (Pix) | N | ? | ? | P (sem editar) | P (Pix) |
| Checagem do total extraído vs total da fatura | **S** | N | N | ? | ? | ? | ? | ? | N | N |
| Open Finance | N | S | S | S | S | S | S | S | P | P |
| Projeção curta (mês) | S | P | N | S | P | S | S | S | N | N |
| **Projeção de 24 meses com parcelas e recorrências** | **S** | N | N | N | N | N | N | P | N | N |
| Lembrete de contas no WhatsApp com resposta "já paguei" | S | N | N | S | S | P | S | S | N | P |
| Resumo semanal e mensal | S | ? | ? | ? | S | ? | ? | ? | N | ? |
| Família ou compartilhado | S | N | N | S | N | N | S | S | N | N |
| **Papéis (owner, membro, leitor) e conta privada** | **S** | N | N | P | N | N | P | N | N | N |
| Carteira consolidada | S | N | N | N | N | S | P | N | S | P |
| Diagnóstico de carteira sem recomendação (CVM 19) | S (+200 prompts adversariais) | N | N | N | N | P | N | N | S | P |
| **Previdência fechada** | **S** | N | N | N | N | N | N | N | N | N |
| Simulação "e se" e "cabe no bolso?" | S | N | N | P | N | ? | N | P | P | N |
| Ponte com ChatGPT/Claude (MCP) | N | N | S | N | N | S | N | N | N | PicPay |
| Alerta de cobrança duplicada ou assinatura nova | N | N | N | P | P | S | N | N | N | N |
| Agente que age (Pix, pagamento) | N (fora do escopo) | N | N | N | S | N | N | N | N | S |
| IR e DARF | P (calendário fiscal, limite de isenção) | N | N | P (NFS-e) | N | N | N | N | planejado | N |
| Self-hosted e dados no próprio servidor | **S** | N | N | N | N | N | N | N | N | N |

### 1.6 Preços de referência (R$/mês)

| Faixa | Exemplos |
| --- | --- |
| Bots de WhatsApp sem conexão bancária | R$ 5,60 (Porquim) a R$ 29,49 (Financinha manual); ZapGastos R$ 9,90 no anual |
| Com Open Finance | R$ 29–40 no anual (Meu Assessor, Grana Smart, Jota Pro, ZapGastos, Financinha, Pierre Pro); R$ 60–70 no mensal |
| Topo de linha | Pierre Premium R$ 199; Jota Max R$ 200 |
| Apps tradicionais | Mobills ~R$ 8,40 (anual); Minhas Economias R$ 24,90; Organizze R$ 29,90–79 |
| Investimentos e IR | Investidor10 R$ 19,90; Grana R$ 19,90–39,90; Gorila grátis |

O padrão é um plano grátis de isca, cerca de R$ 30/mês no anual como plano principal e cobrança por conta conectada ou por membro.

### 1.7 Reclamações mais comuns

1. **Sincronização quebrada e dados errados:** Mobills, Kinvo, Meu Assessor, Minhas Economias.
2. **Perda de histórico em migrações:** Kinvo (Open Finance só trouxe dados de 2026 em diante).
3. **Suporte lento ou inexistente:** Mobills sem resposta; Kinvo com 20 dias de média.
4. **Cobrança e cancelamento nos bots:** Meu Assessor e ZapGastos (compra duplicada, cancelamento ignorado).
5. **Parcelas e cartão mal modelados:** Meu Assessor, Minhas Economias.
6. **Preço subindo e grátis encolhendo:** Organizze; cobrança por conta conectada.
7. **Desconfiança com dados no WhatsApp:** posição pública do C6.

## 2. Tendências globais em IA e agentes

### 2.1 Produtos de referência

- **Cleo** (EUA/UK): voz, memória de longo prazo (guarda resumos e sentimento, não transcrições) e um agente de fundo que puxa assunto sozinho. Arquitetura multiagente: um roteador classifica a mensagem e especialistas respondem; abandonaram o "mega-prompt" ([blog](https://web.meetcleo.com/blog/inside-cleos-multi-agent-architecture)). O **Autopilot** (fev/2026) recomenda num dia e executa no seguinte, dentro de limites. Fatura ~US$ 254 mi, mas 62% vêm de antecipação de dinheiro, o que gerou acordo de US$ 17 mi com a FTC ([FTC](https://www.ftc.gov/news-events/news/press-releases/2025/03/cash-advance-company-cleo-ai-agrees-pay-17-million-result-ftc-lawsuit-charging-it-deceives-consumers)).
- **Rocket Money Rowan** (ago/2026, feito com a Anthropic): agente por SMS que monitora 24/7, avisa de teste grátis esquecido e cancela quando o usuário responde "cancel". Renegocia contas e cria regras em linguagem natural. "Agentes adaptáveis onde precisa de flexibilidade e código rígido onde precisa de certeza" ([PRNewswire](https://www.prnewswire.com/news-releases/rocket-moneys-rowan-rewrites-what-ai-can-do-in-personal-finance-302859522.html)).
- **Monarch Money**: assistente que usa o contexto do domicílio, insight em cada widget, resumo semanal com perguntas de follow-up, recibo por foto casado com a transação e dividido em itens. Elogiado pela colaboração de casais ([Monarch](https://www.monarch.com/blog/winter-release)).
- **Copilot Money**: o assistente altera orçamento, categorias e regras, sempre com aprovação prévia.
- **Origin**: "consultor de IA" de empresa registrada na SEC. Especialistas por domínio, cálculo em motores determinísticos, checagem de compliance em cada resposta e CFP humano sob demanda por US$ 119 ([Origin](https://useorigin.com/resources/blog/introducing-the-first-sec-regulated-ai-financial-advisor)).
- **Revolut AIR** (abr/2026): congela cartão, pausa recorrência e define limites pelo chat, com biometria antes de ações sensíveis e zero retenção nos provedores de IA.
- **ChatGPT Finances** (mai/2026) e **Perplexity + Plaid** (abr/2026): só leitura, só EUA e Canadá. ChatGPT mostra memórias financeiras que o usuário vê e apaga ([TechCrunch](https://techcrunch.com/2026/05/15/openai-launches-chatgpt-for-personal-finance-will-let-you-connect-bank-accounts/)). **Não há equivalente no Brasil.**
- **Pine AI**: agente de voz que liga para empresas, espera na fila, negocia e cobra 10–30% da economia obtida.
- **Brasil, infraestrutura agêntica:** o Iniciador lançou um MCP de Pix agêntico com confirmação biométrica (mai/2026), já ligado a agentes de WhatsApp ([Iniciador](https://iniciador.com.br/en/conteudos/iniciador-anuncia-pagamentos-agenticos-full-stack-ai-toolkit)). Visa e Mastercard fizeram as primeiras transações agênticas no país em mar/2026.

### 2.2 Tendências

1. **De insight para ação, com confirmação mínima** (Rowan, Cleo Autopilot, Revolut, Copilot).
2. **Proativo vence reativo.** O Jota 2.0 diz ter visto até 5x mais engajamento depois de virar proativo ([Finsiders](https://finsidersbrasil.com.br/giro-noticias/jota-capta-r-150-milhoes-e-lanca-versao-2-0-do-assistente/)).
3. **Memória persistente e editável** (Cleo, ChatGPT).
4. **Multiagente com roteador e cálculo determinístico** (Cleo, Origin, Rowan).
5. **A regra decide, a IA explica** (Betterment, Origin).
6. **Mensageria e voz como canal principal.**
7. **MCP como canal de distribuição:** MCPs para Monarch, YNAB, Copilot; no Brasil, Organizze, Pierre, Minhas Economias e TradeMap.
8. **Casal e família como unidade de planejamento** (Monarch, Halfway, Poupa.ai casal).
9. **Uso alto, confiança baixa:** 55% dos americanos usaram IA para finanças em 12 meses, mas só 3% confiam "muito" ([Gallup/AP](https://abcnews.com/Technology/wireStory/us-adults-ai-financial-guidance-trust-gallup-poll-135452999)). No Brasil, 73% aceitam recomendação de IA desde que mantenham controle dos dados (pesquisa Mercado Pago).

### 2.3 Padrões de confiança que estão virando norma

- **Escala de autonomia:** observar → recomendar → preparar (usuário confirma) → executar dentro de limites → otimizar por objetivo. O app hoje está no nível "preparar", que é o certo para dados financeiros.
- **Mandatos:** finalidade, contas, limite por operação e por período, validade, revogação.
- **Aprovação por exceção:** pedir confirmação só em valor alto, beneficiário novo ou mudança relevante.
- **Execução programada com janela para cancelar:** "amanhã às 9h vou registrar X; responda PARAR para cancelar".
- **Memória visível e apagável.**
- **Nunca** tratar texto do modelo como autorização, nem deixar o agente subir os próprios limites.
- **Injeção de prompt por documento é real:** no benchmark InjecAgent um agente pagou uma conta de US$ 500 por instrução escondida numa nota ([arXiv](https://arxiv.org/pdf/2403.02691)); a Zscaler relatou ataques reais em jul/2026 ([SecurityWeek](https://www.securityweek.com/prompt-injection-attacks-trick-ai-agents-into-making-crypto-payments/)). Num experimento com boletos em PDF, só a checagem humana do beneficiário funcionou ([HackerNoon](https://hackernoon.com/testing-provenance-based-controls-against-indirect-prompt-injection-in-ai-agents)).

### 2.4 Lições de modelo de negócio

- O Mint fechou com 20+ milhões de usuários: anúncios e agregação cara não se pagam.
- O Guiabolso e a Olivia foram absorvidos por bancos.
- A Cleo é rentável por antecipação de dinheiro, com risco regulatório.
- Retenção em 30 dias de apenas 4–7% em apps novos do segmento (dado de blog sobre números da AppsFlyer, [Sendbird](https://sendbird.com/blog/finance-and-payment-app-retention)).
- **Só acompanhar gastos não retém. O que retém é impacto concreto** (evitar um juro, uma cobrança, um mês no vermelho).

## 3. O que o app já tem e o que falta

| Diferencial já implementado | Paridade que falta (o mercado tem, nós não) | Oportunidade que ninguém tem |
| --- | --- | --- |
| Projeção de 24 meses com parcelas, recorrências e faixa otimista/pessimista | Ponte com ChatGPT/Claude via MCP (Organizze, Pierre, Minhas Economias) | Comprometimento de renda futura como métrica principal |
| Previdência fechada por extrato | Alerta de cobrança duplicada, assinatura nova e tarifa (Pierre) | Calendário financeiro brasileiro injetado na projeção |
| Draft, prévia, confirmação, auditoria e desfazer | Agente proativo além dos resumos (Jota 2.0, Cleo) | Dossiê de IRPF contínuo, incluindo previdência fechada |
| Checagem do total extraído vs total da fatura e sinal de baixa confiança | Recibo e cupom item a item (Monarch) | Proveniência campo a campo e alerta de beneficiário novo |
| Papéis owner, membro e leitor; conta privada; RLS | Open Finance (todos os bots têm) | Aposentadoria com previdência fechada além de 24 meses |
| Nota de corretagem com taxas e preço médio | Telegram como segundo canal (ZapGastos) | Self-hosted com IA e WhatsApp, em português |
| Diagnóstico de carteira com 200 prompts adversariais (CVM 19) | Memória editável (Cleo, ChatGPT) | Antigolpe a partir do que o usuário encaminha |
| Lembretes com resposta "já paguei", resumos, alerta de piso | | |
| Simulação, "cabe no bolso?", quanto posso gastar, reserva de emergência | | |
| LGPD: consentimento, exportação, expurgo, mascaramento antes do LLM | | |
| Roteamento de modelo pequeno e grande, provedor fake para testes | | |

## 4. Diferenciais propostos

Priorizados por impacto e custo para uso pessoal. "Reaproveita" aponta o que já existe no código.

### 4.1 IA e agentes

| # | Diferencial | Por que | Reaproveita |
| --- | --- | --- | --- |
| A1 | **Agente de fundo proativo** ("CFO da família"). Além dos resumos, detecta anomalias: cobrança duplicada, assinatura nova, anuidade, seguro embutido no cartão, tarifa que subiu, gasto fora do padrão. Propõe a ação com janela para cancelar ("vou registrar o cancelamento amanhã; responda PARAR"). | Rowan, Cleo, Jota 2.0. Ataca a dor nº 1 e é o que gera "impacto concreto" | `apps/worker/src/jobs/insights.ts`, `reminders.ts`, drafts |
| A2 | **Proveniência na prévia.** Cada campo extraído aponta a página e o trecho de origem; a prévia destaca beneficiário ou CNPJ novo e item com baixa confiança. | Combate alucinação e injeção de prompt; ninguém no Brasil mostra. A checagem de total e o `lowConfidence` já existem | `apps/api/src/import/extract.ts`, `apps/api/src/agent/tools-docs.ts` |
| A3 | **Comprometimento de renda futura** como métrica principal: "38% da renda de março já está comprometida com parcelas", com gráfico por mês e "cabe no bolso?" na mesma resposta. | Parcelado é muito brasileiro; nenhum app global faz; o Financinha faz só para uma compra | `apps/api/src/domain/projection.ts`, `evaluate_purchase` |
| A4 | **Calendário financeiro brasileiro.** IPVA, IPTU, matrícula e material escolar, 13º, reajuste de plano de saúde e escola, IRPF, come-cotas. Aprendido do histórico e sugerido 30–60 dias antes, já na projeção. | Nenhum concorrente; resolve o "mês que estoura" | `apps/api/src/domain/forecast.ts`, recorrências |
| A5 | **Dossiê de IRPF contínuo.** Recibos de saúde e educação, informes de rendimento, contribuições de previdência fechada (dedutíveis até 12% da renda tributável), ganhos de capital e proventos. Pacote pronto antes de março. | Combina com o gap único de previdência fechada; o chatbot da Receita só tira dúvidas | anexos, `apps/api/src/domain/portfolio.ts`, `get_pension` |
| A6 | **Memória financeira editável:** "o que eu sei sobre você" (metas, preferências, contexto da família), visível e apagável. | Cleo, ChatGPT Finances; alinha com LGPD | `apps/api/src/agent/prompts.ts`, nova tabela |
| A7 | **Antigolpe conversacional.** O usuário encaminha a mensagem, o QR ou o boleto suspeito; o agente lê o payload do Pix e a linha digitável, compara o recebedor com o histórico e avisa de padrões de golpe. | Golpes de Pix; extensão natural da prévia | parsers em `packages/shared` (ver I4) |
| A8 | **Caçador de cobranças com rascunho de cancelamento ou reclamação** (texto para o SAC ou para o consumidor.gov.br). O usuário envia. | Rowan e Pine adaptados ao Brasil, sem mover dinheiro | A1 |
| A9 | **Cenários de vida e aposentadoria:** estender além de 24 meses usando saldo e contribuições da previdência fechada ("se eu aposentar em 2040, quanto recebo e quanto falta?"). | A Monarch promete para 2026; ninguém no Brasil | `simulate`, `get_pension` |
| A10 | **Agente no grupo de WhatsApp da família:** divisão de despesas proporcional à renda, resumo por membro, mesada. | Halfway, Origin para casais; os papéis já existem | workspaces e papéis |
| A11 | **Formalizar a arquitetura:** roteador, especialistas por domínio, motores determinísticos para todo número e evals por fluxo (extração, lançamento, consulta). | Cleo, Origin, Rowan; já há roteamento de modelo, `compliance.ts` e `eval:cvm` | `apps/api/src/agent/orchestrator.ts`, `registry.ts` |

### 4.2 Integrações

Todas cabem em escala pessoal e quase não têm custo.

| # | Integração | Custo | Observação |
| --- | --- | --- | --- |
| I1 | **Servidor MCP próprio** para Claude e ChatGPT: leitura e drafts com confirmação no app | ~0 | Paridade com Organizze e Pierre. O diretório de conectores da Claude aceita MCP remoto por formulário; o de apps do ChatGPT aceita submissões desde dez/2025 |
| I2 | **E-mail de entrada:** encaminhar faturas e boletos para um endereço do app | ~0 (caixa IMAP ou roteamento de e-mail para webhook) | Maior alavanca de retenção: as faturas já chegam por e-mail, então o usuário não precisa lembrar de importar |
| I3 | **NFC-e por QR code:** consulta no portal da SEFAZ do estado (não há API nacional); Infosimples como opção paga, 26 estados | baixo | Itens do cupom viram categorias ([Infosimples](https://infosimples.com/consultas/sefaz-nfce/)) |
| I4 | **Parsers de boleto e Pix:** linha digitável (o fator de vencimento reiniciou em 1000 em 22/02/2025) e Pix copia e cola (BR Code EMV com CRC16) | 0 | Base para A7 e para registrar conta a pagar sem LLM ([Baguete](https://www.baguete.com.br/noticias/boletos-tem-repeteco-do-bug-do-milenio)) |
| I5 | **Telegram** como segundo canal, oficial e grátis, atrás de `MessagingChannel` | 0 | Reduz o risco de banimento do número na Evolution |
| I6 | **Feed ICS de vencimentos** para Google e Apple Calendar | 0 | Trivial |
| I7 | **Extrato da B3 (Área do Investidor, Excel) e CSV do Tesouro Direto** | 0 | A API da B3 é licenciada e paga ([developers.b3](https://developers.b3.com.br/apis/api-area-do-investidor)); o Tesouro só tem CSV ([Tesouro Transparente](https://www.tesourotransparente.gov.br/ckan/dataset/taxas-dos-titulos-ofertados-pelo-tesouro-direto)) |
| I8 | **Open Finance.** Para uso estritamente pessoal, o Meu Pluggy permite até 5 conexões do próprio titular, mas não serve para colocar outros usuários num produto. Para produto, o mínimo é Pluggy a partir de R$ 2.500/mês, Belvo US$ 1.000/mês, Tecnospeed R$ 540/mês (relato não verificado) | 0 / alto | Só vale se virar negócio. O BC prepara uma regra de parcerias com consentimento por parceiro e proibição de repassar dados ([Finsiders](https://finsidersbrasil.com.br/economia-open/bc-propoe-novas-regras-para-uso-de-dados-de-clientes-no-open-finance/)) |
| I9 | **Pix agêntico (MCP do Iniciador) e Pix Automático** | contrato | Acompanhar. Pix Automático movimentou ~R$ 1,2 bi em mai/2026, mas o próprio BC diz que ainda está em teste |
| — | **Transcrição de áudio** (já existe) | <US$ 0,001 por áudio | Deepgram Nova-3 US$ 0,0043/min; gpt-4o-mini-transcribe ~US$ 0,003/min; ElevenLabs Scribe declara a melhor taxa de erro em português. Testar com áudios reais |

Fora do caminho: ler SMS de banco no Android (o Google Play só libera `READ_SMS` para o app padrão de SMS) e a API da Receita (não existe para terceiros; o caminho é o usuário enviar os informes e a declaração).

### 4.3 Facilidade de entrada no nicho

- **Nichos com dor sem dono:**
  - participantes de previdência fechada (Previsc e outros fundos de pensão), que nenhum app acompanha;
  - cooperados de crédito (Cresol, Sicoob, Sicredi), cujos extratos os apps leem mal: há ~29 milhões de cooperados no Brasil, cerca de 8 em 10 no ramo crédito ([Sicoob/OCB](https://www.sicoob.com.br/web/sicoobcentralscrs/noticias/-/asset_publisher/xAioIawpOI5S/content/id/325012916));
  - famílias com várias contas e cartões.
- **Distribuição open source e self-hosted.** Não existe um equivalente brasileiro do Firefly III ou do Actual Budget com IA e WhatsApp. Publicar no GitHub e em comunidades de self-hosting é canal de custo zero. Privacidade (dados no próprio servidor, chave de criptografia do próprio usuário) responde ao argumento do C6 de que "o WhatsApp expõe dados".
- **Se um dia cobrar:**
  - R$ 10–20/mês, com o plano anual em destaque;
  - Asaas para Pix Automático (Pix R$ 1,99, cartão 2,99% + R$ 0,49) ([taxas](https://www.asaas.com/precos-e-taxas)), porque a Stripe Brasil não oferece Pix Automático para empresas sediadas no Brasil ([Stripe](https://docs.stripe.com/payments/pix));
  - cancelamento em um clique (CDC art. 49 e leis estaduais do RJ e MS);
  - conversão esperada de 2% em freemium e ~11% com paywall obrigatório (RevenueCat, via [Airbridge](https://www.airbridge.io/en/blog/hard-paywall-vs-freemium-2026)).
- **Tamanho do problema:**
  - 82% das famílias endividadas e 29,9% com contas em atraso; o cartão é a principal dívida para 85,3% delas (PEIC/CNC, ago/2026, [Mercado&Consumo](https://mercadoeconsumo.com.br/06/08/2026/noticias/cnc-endividamento-das-familias-sobe-para-82-mas-inadimplencia-cai/));
  - 82,8 milhões de inadimplentes (Serasa, mar/2026);
  - 53% dos trabalhadores terminam o mês sem dinheiro (Serasa, jun/2026);
  - o WhatsApp está na tela inicial de 65% dos smartphones ([Mobile Time](https://www.mobiletime.com.br/noticias/17/06/2026/super-panorama-26/)).

## 5. Riscos e conformidade

| Risco | Situação | Mitigação |
| --- | --- | --- |
| **Regra da Meta contra chatbots de IA de uso geral** | Vale desde 15/01/2026, mas no Brasil o CADE suspendeu por medida preventiva, mantida pelo plenário em 04/03/2026 ([CNN Brasil](https://www.cnnbrasil.com.br/economia/negocios/cade-mantem-medida-preventiva-que-obriga-meta-a-permitir-chatbots-de-ia-no-whatsapp/)). A Meta passou a cobrar US$ 0,0625 por mensagem de "AI Providers" no Brasil ([TechCrunch](https://techcrunch.com/2026/03/06/after-europe-whatsapp-will-let-rival-ai-companies-offer-chatbots-in-brazil/)) | Manter o bot restrito a finanças (tarefa específica) e recusar assuntos fora do domínio |
| **Custo da API oficial** | Desde 01/10/2026 as mensagens de serviço dentro da janela de 24h são cobradas depois de 1.000 grátis por número por mês; utilidade custa US$ 0,0068–0,008 no Brasil ([360dialog](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/)). Confirmar na tabela oficial da Meta | Para uso pessoal, a franquia grátis tende a bastar |
| **Banimento na Evolution API** | Baileys é engenharia reversa e viola os termos; número banido raramente volta | Telegram (I5) como reserva; a Evolution também fala com a Cloud API, então dá para migrar sem trocar de stack |
| **LGPD: transferência internacional** | A Res. CD/ANPD 19/2024 exige cláusulas-padrão para enviar dados ao provedor de LLM nos EUA; o prazo de adequação venceu em ago/2025 ([Migalhas](https://www.migalhas.com.br/depeso/414728/anpd-regulamenta-transferencia-internacional-de-dados-impactos)) | Registrar sub-operadores e cláusulas com o provedor; manter o mascaramento antes do LLM |
| **CVM 19** | Consultoria automatizada tem as mesmas obrigações (art. 17); a Res. CVM 246 (jul/2026) criou divisão para IA | Manter diagnóstico sem recomendação de ativo |
| **Marco da IA (PL 2338)** | Aprovado no Senado, ainda na Câmara | Acompanhar |
| **Concorrência gratuita** | Bancos com IA, Nu Smart Invest, Jota com R$ 150 mi | Não competir em amplitude; competir em profundidade (projeção, previdência, multibanco, privacidade) |

## 6. O que não fazer

- Competir em "lançar gasto por WhatsApp": é commodity.
- Pagar Open Finance antes de validar o uso.
- Crédito ou antecipação de dinheiro (caso Cleo e FTC).
- Anúncios (caso Mint).
- Recomendar ativo específico (CVM 19).
- Executar pagamento sem mandato e confirmação forte.

## 7. Roadmap sugerido

| Fase | Itens | Critério |
| --- | --- | --- |
| **Agora** (custo ~0, cada item cabe em até 2 semanas) | A2 proveniência na prévia; A3 comprometimento de renda; I2 e-mail de entrada; I4 parsers de boleto e Pix; I1 servidor MCP | Lançar dados sem abrir o app e confiar no que foi extraído |
| **Próximo** | A1 agente proativo com A8; A4 calendário brasileiro; A5 dossiê de IRPF; I5 Telegram; I3 NFC-e | O app avisa antes de o problema acontecer |
| **Depois** | A6 memória; A9 aposentadoria; A10 grupo da família; A7 antigolpe completo; I8 e I9 só se virar produto | Profundidade para a família e para o longo prazo |

## Fontes

**Concorrentes no Brasil**

- Mobills: [planos](https://www.mobills.com.br/planos/), [Reclame Aqui](https://www.reclameaqui.com.br/mobills-educacao-financeira/divergencia-de-saldo-no-aplicativo-mobills-e-falhas-no-suporte_8ec0Z9Jb38txg9Me/)
- Organizze: [planos](https://www.organizze.com.br/planos)
- Minhas Economias: [App Store](https://apps.apple.com/br/app/minhas-economias/id520869873)
- Meu Assessor: [site](https://meuassessor.com), [Reclame Aqui](https://www.reclameaqui.com.br/meu-assessor/aplicativo-com-bugs-e-sem-solucao-solicitacao-de-cancelamento-e-reembolso_-Jp_GzhKWnv2Plm-/)
- Jota: [site](https://jota.ai/), [Finsiders](https://finsidersbrasil.com.br/giro-noticias/jota-capta-r-150-milhoes-e-lanca-versao-2-0-do-assistente/)
- Pierre: [planos](https://lp.pierre.finance/), [MCP](https://www.letsmoney.com.br/destaque/pierre-mcp-alexa-financas/)
- ZapGastos: [planos](https://zapgastos.com/planos), [Reclame Aqui](https://www.reclameaqui.com.br/empresa/zapgastos-com/lista-reclamacoes/)
- Gorila: [Gorila AI](https://gorila.com.br/ai/)
- Kinvo: [Reclame Aqui](https://www.reclameaqui.com.br/empresa/kinvo/lista-reclamacoes/)
- Investidor10: [ferramentas](https://investidor10.com.br/conteudo/ferramentas-controle-de-investimento/)
- Bancos:
  - Nubank: [Mobile Time](https://www.mobiletime.com.br/?p=854164)
  - Itaú ia.i: [Canaltech](https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos)
  - Inter Seven: [CNN](https://www.cnnbrasil.com.br/economia/negocios/conheca-a-seven-nova-assistente-de-ia-do-super-app-do-inter/)
  - C6 Assistant: [Let's Money](https://www.letsmoney.com.br/ia/c6-assistant-analise-gastos-conta-fatura/)
  - PicPay: [Tecnoblog](https://tecnoblog.net/noticias/picpay-lanca-ia-no-whatsapp-capaz-de-fazer-pix/), [plugin no ChatGPT](https://consumidormoderno.com.br/picpay-consultas-financeiras-chatgpt/)
  - Bradesco BIA: [Convergência Digital](https://convergenciadigital.com.br/mercado/bradesco-lanca-pix-por-comando-de-voz-pelo-whatsapp-da-ia-generativa-bia/)
- Comparativo de bots: [Data Hackers](https://www.datahackers.news/p/comparativo-porquim-ia-vs-outras-ferramentas-financeiras-de-whatsapp), [Controlei](https://www.controlei.app/melhores-apps-controle-financeiro-whatsapp.html)

**Tendências globais**

- Cleo: [3.0](https://www.businesswire.com/news/home/20250729690058/en/Cleo-Becomes-the-First-AI-Money-Coach-That-Speaks-Thinks-and-Remembers), [Autopilot](https://www.prnewswire.com/news-releases/cleo-launches-autopilot-automating-your-money-moves-302679691.html), [Sacra](https://sacra.com/c/cleo/)
- Rocket Money Rowan: [Fintech Global](https://fintech.global/2026/09/03/rocket-money-launches-ai-agent-to-manage-finances/)
- Revolut AIR: [Finextra](https://www.finextra.com/newsarticle/47551/revolut-introduces-ai-assistant-for-money-management)
- Monzo: [FCA AI Live Testing](https://monzo.com/blog/fca-ai-live-testing-insights)
- Perplexity: [Plaid](https://plaid.com/blog/plaid-perplexity-ai-financial-insights-integration/)
- Pix e agentes: [Finsiders/ABOF](https://finsidersbrasil.com.br/pagamentos/pix/como-o-pix-pode-ser-usado-por-agentes-de-ia/), [Iniciador e Tyxter](https://www.letsmoney.com.br/noticias/iniciador-tyxter-pix-agentico-whatsapp/)
- Pesquisas de uso: [Plaid State of Intelligent Finance](https://plaid.com/state-of-intelligent-finance-report/), [EY](https://www.ey.com/en_ro/newsroom/2026/05/nearly-half-of-global-consumers-now-use-ai-to-guide-savings-and-)

**Integrações, regulação e mercado**

- Open Finance:
  - [208 mi de consentimentos](https://www.letsmoney.com.br/noticias/open-finance-208-milhoes-consentimentos-governanca/)
  - [modelo de participação](https://openfinancebrasil.org.br/modelo-de-participacao/)
  - Preços: [Pluggy](https://www.pluggy.ai/en/pricing), [Belvo](https://belvo.com/plans-and-pricing/), [relato no TabNews](https://www.tabnews.com.br/GuilhermeVieira/estou-desenvolvendo-um-app-de-financas-pessoais-e-nao-consigo-pagar-o-open-finance-pluggy-r2-5k-mes-belvo-r6k-mes-tecnospeed-r1-5k-de-entrada-r540)
- Pix:
  - Pix Automático: [Finsiders](https://finsidersbrasil.com.br/pagamentos/pix/um-ano-depois-pix-automatico-ainda-nao-pegou-e-ha-um-motivo)
  - Pix por aproximação: [Tecnoblog](https://tecnoblog.net/noticias/pix-por-aproximacao-nao-tera-mais-limite-de-r-500-por-transacao/)
- WhatsApp:
  - [preços da Meta](https://developers.facebook.com/docs/whatsapp/pricing/)
  - [regra de chatbots](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban)
  - [CADE e Meta, multa diária](https://mercadoeconsumo.com.br/23/04/2026/noticias/cade-mantem-multa-diaria-contra-a-meta-no-caso-envolvendo-uso-de-chatbots-de-ia-no-whatsapp/)
  - [Evolution vs API oficial](https://horadecodar.com.br/evolution-api-vs-api-oficial-whatsapp/)
  - [360dialog](https://www.360dialog.com/pricing)
  - [Z-API](https://z-api.io/)
- Dados e transcrição:
  - [brapi](https://brapi.dev/pricing)
  - [Deepgram](https://deepgram.com/pricing)
  - [Gladia](https://www.gladia.io/pricing)
  - [ElevenLabs pt-BR](https://elevenlabs.io/pt/speech-to-text/portuguese)
- Regulação:
  - CVM, robôs de investimento: [Portal do Investidor](https://investidor.cvm.gov.br/menu/Menu_Investidor/prestadores_de_servicos/robos_investimento.html)
  - ANPD, decisões automatizadas: [Convergência Digital](https://convergenciadigital.com.br/governo/anpd-avanca-na-regulacao-de-decisoes-automatizadas-por-ia/)
  - PL 2338: [Demarest](https://www.demarest.com.br/inteligencia-artificial-reacende-debates-na-camara-dos-deputados/)
- Mercado:
  - Serasa: [inadimplência](https://www.dgabc.com.br/Noticia/4317691/inadimplencia-bate-82-8-milhoes-de-brasileiros-em-marco-segundo-serasa), [trabalhadores](https://www.serasaexperian.com.br/sala-de-imprensa/solucoes-para-rh/financas-53-por-cento-dos-trabalhadores-chegam-ao-fim-do-mes-sem-dinheiro-na-conta-revela-serasa-experian/)
  - Anbima: [Raio X do Investidor 2026](https://uploads.finsidersbrasil.com.br/2026/04/Raio-X-do-Investidor-9-edicao.pdf)

**Ressalvas**

- Números de usuários são declarados pelas empresas.
- O Reclame Aqui bloqueou o acesso direto; os dados vieram de trechos de busca.
- Fontes únicas ou não verificadas:
  - preços da Tecnospeed e da Belvo em reais;
  - bug da Cleo com a Plaid;
  - tabela da Meta de outubro/2026 em reais.
- Não foram verificados:
  - política do Google Play para leitura de notificações;
  - preços de Gupshup e Blip;
  - situação do caso CADE × Meta depois de abril/2026.
