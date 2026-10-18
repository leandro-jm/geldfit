import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { fold, hasPaymentCode, parseAmount } from '@sf/shared';
import {
  LLMError,
  textOf,
  type ChatRequest,
  type ChatResponse,
  type ExtractRequest,
  type ExtractResponse,
  type LLMContent,
  type LLMProvider,
} from './types.js';

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0 };

/**
 * Provedor determinístico baseado em regras. Serve para testes e para rodar o app sem chave de
 * LLM (modo demonstração). Reconhece as frases mais comuns do PRD e chama as mesmas tools que um
 * modelo real chamaria; o backend continua validando tudo.
 */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  constructor(private extractHandler?: (req: ExtractRequest<z.ZodType>) => unknown) {}

  async chat(req: ChatRequest, onTextDelta?: (text: string) => void): Promise<ChatResponse> {
    const last = req.messages[req.messages.length - 1];
    let content: LLMContent[];
    if (last?.content.some((c) => c.type === 'tool_result')) {
      content = [{ type: 'text', text: summarizeToolResults(last.content) }];
    } else {
      const text = last ? textOf(last.content) : '';
      const hasAttachment = /\[anexo:([0-9a-f-]{36})/.exec(text);
      const call = hasAttachment
        ? { name: 'import_attachment', input: { attachment_id: hasAttachment[1] } }
        : route(text);
      content = call
        ? [{ type: 'tool_call', id: `fake_${randomUUID()}`, name: call.name, input: call.input }]
        : [
            {
              type: 'text',
              text: 'Não entendi. Você pode dizer, por exemplo, "paguei 230 de luz no BB ontem" ou "quanto sobra em dezembro?".',
            },
          ];
    }
    const text = textOf(content);
    if (text && onTextDelta) for (const chunk of text.match(/.{1,12}/gs) ?? []) onTextDelta(chunk);
    return {
      content,
      stopReason: content.some((c) => c.type === 'tool_call') ? 'tool_use' : 'end',
      usage: ZERO,
      model: 'fake',
      provider: this.name,
      latencyMs: 0,
    };
  }

  async extract<T extends z.ZodType>(req: ExtractRequest<T>): Promise<ExtractResponse<z.infer<T>>> {
    if (!this.extractHandler)
      throw new LLMError('Extração por LLM indisponível no modo demonstração.', 'unavailable');
    const data = req.schema.parse(this.extractHandler(req as unknown as ExtractRequest<z.ZodType>));
    return { data, usage: ZERO, model: 'fake', provider: this.name, latencyMs: 0 };
  }
}

function summarizeToolResults(content: LLMContent[]): string {
  const results = content.filter(
    (c): c is Extract<LLMContent, { type: 'tool_result' }> => c.type === 'tool_result',
  );
  const parts: string[] = [];
  for (const r of results) {
    try {
      const data = JSON.parse(r.content) as Record<string, unknown>;
      if (r.isError || data.error) parts.push(String(data.error ?? data.message ?? 'Não consegui concluir.'));
      else if (typeof data.answer === 'string') parts.push(data.answer);
      else if (data.draft_id) parts.push('Confira a prévia e confirme para gravar.');
      else parts.push('Pronto.');
    } catch {
      parts.push(r.content);
    }
  }
  return parts.join('\n');
}

const AMOUNT = String.raw`(?:r\$\s*)?(\d[\d.,]*(?:\s*(?:k|mil|mi)\b)?)`;

/** Mapeia frases comuns para chamadas de tool. */
export function route(raw: string): { name: string; input: Record<string, unknown> } | null {
  const s = fold(raw);

  // linha digitável de boleto ou Pix copia e cola
  if (hasPaymentCode(raw)) {
    const account = s.match(/\b(?:no|na|pelo|pela)\s+([a-z0-9]+)\s*$/)?.[1] ?? null;
    return { name: 'draft_bill', input: { code: raw, account } };
  }

  // memória: "lembra que meu filho nasce em março", "esquece que eu queria viajar", "o que você sabe sobre mim?"
  let mem = s.match(/^(?:lembra|lembre|anota|anote|guarda|guarde)(?:-se)?\s+(?:que\s+)?(.{3,})$/);
  if (mem) {
    const fact = raw.trim().replace(/^\S+(?:-se)?\s+(?:que\s+)?/i, '');
    const category = /filh|esposa|marido|famil|nasce|casament/.test(s)
      ? 'familia'
      : /quero|pretendo|vou|sonho|plano|meta/.test(s)
        ? 'objetivo'
        : /prefiro|gosto/.test(s)
          ? 'preferencia'
          : 'contexto';
    return { name: 'remember', input: { content: cap(fact), category } };
  }
  mem = s.match(/^(?:esquece|esqueca|apaga da memoria)\s+(?:que\s+)?(.{3,})$/);
  if (mem) return { name: 'forget', input: { search: mem[1] } };
  if (/o que (?:voce )?sabe (?:sobre|de) mim|o que voce lembra/.test(s))
    return { name: 'list_memories', input: {} };
  if (/^(?:como estao |quais sao )?minhas metas\??$/.test(s)) return { name: 'list_goals', input: {} };

  // "todo dia 5 entra 8.500 de salário no BB"
  let m = s.match(
    new RegExp(
      String.raw`todo (?:dia (\d{1,2})|mes)[^\d]*?(entra|recebo|cai|pago|sai|vence)\s+${AMOUNT}\s*(?:de|do|da)?\s*([a-z ]+?)(?:\s+(?:no|na|pelo|pela)\s+(.+))?$`,
    ),
  );
  if (m) {
    const day = Number(m[1] ?? 1);
    const dir = /entra|recebo|cai/.test(m[2]!) ? 'in' : 'out';
    return {
      name: 'draft_recurrence',
      input: {
        description: cap(m[4]!),
        amount: m[3]!,
        direction: dir,
        frequency: 'monthly',
        day_of_month: day,
        account: m[5] ?? null,
        start_date: null,
      },
    };
  }

  // "comprei uma TV de 3.600 em 10x no cartão Santander"
  m = s.match(
    new RegExp(
      String.raw`(?:comprei|parcelei)\s+(?:uma?\s+|o\s+|a\s+)?(.+?)\s+(?:de|por)\s+${AMOUNT}\s+em\s+(\d{1,2})\s*x(?:\s+(?:no|na)\s+(?:cartao\s+)?(.+))?$`,
    ),
  );
  if (m) {
    return {
      name: 'draft_transactions',
      input: {
        items: [
          {
            description: cap(m[1]!),
            amount: m[2]!,
            direction: 'out',
            date: 'hoje',
            installments: Number(m[3]),
            card: m[4] ?? null,
          },
        ],
      },
    };
  }

  // "paguei 230 de luz no BB ontem" / "gastei 50 no mercado" / "recebi 1.200 de freela no Santander"
  m = s.match(
    new RegExp(
      String.raw`^(paguei|gastei|comprei|recebi|ganhei|entrou)\s+${AMOUNT}\s*(?:reais)?\s*(?:de|do|da|em|no|na|com)?\s*(.*)$`,
    ),
  );
  if (m) {
    const dir = /recebi|ganhei|entrou/.test(m[1]!) ? 'in' : 'out';
    let rest = m[3] ?? '';
    let date = 'hoje';
    const dm = rest.match(/\s*(ontem|anteontem|hoje|dia \d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*$/);
    if (dm) {
      date = dm[1]!;
      rest = rest.slice(0, dm.index).trim();
    }
    let account: string | null = null;
    let card: string | null = null;
    const am = rest.match(/\s+(?:no|na|pelo|pela)\s+(cartao\s+)?([a-z0-9 ]+)$/);
    if (am) {
      if (am[1]) card = am[2]!.trim();
      else account = am[2]!.trim();
      rest = rest.slice(0, am.index).trim();
    }
    if (!account && !card) {
      const only = rest.match(/^(?:no|na)\s+(cartao\s+)?([a-z0-9 ]+)$/);
      if (only) {
        if (only[1]) card = only[2]!;
        else account = only[2]!;
        rest = '';
      }
    }
    const description = cap(
      rest.replace(/^(de|do|da|com|no|na)\s+/, '') || (dir === 'in' ? 'Receita' : 'Despesa'),
    );
    return {
      name: 'draft_transactions',
      input: {
        items: [{ description, amount: m[2]!, direction: dir, date, account, card, installments: 1 }],
      },
    };
  }

  // "transferi 500 do BB para o Santander"
  m = s.match(
    new RegExp(
      String.raw`transferi\s+${AMOUNT}\s+(?:do|da)\s+(.+?)\s+(?:para|pro|pra)\s+(?:o\s+|a\s+)?(.+)$`,
    ),
  );
  if (m)
    return {
      name: 'draft_transfer',
      input: { amount: m[1]!, from_account: m[2]!, to_account: m[3]!, date: 'hoje' },
    };

  // "corrige o último lançamento para 250"
  m = s.match(new RegExp(String.raw`corrig\w*\s+o\s+ultimo\s+lancamento\s+(?:para|pra)\s+${AMOUNT}`));
  if (m) return { name: 'draft_edit', input: { target: 'last', changes: { amount: m[1]! } } };

  // "apaga a compra da farmácia" / "desfaz"
  m = s.match(
    /^(?:apaga|exclui|remove|deleta)\s+(?:o|a)?\s*(?:ultimo lancamento|compra|lancamento|despesa|receita)?\s*(?:d[aoe]s?\s+)?(.*)$/,
  );
  if (m) return { name: 'draft_delete', input: m[1] ? { search: m[1].trim() } : { target: 'last' } };
  if (/^(desfaz|desfazer)/.test(s)) return { name: 'undo_last', input: {} };

  // "posso comprar uma TV de 4.000 em 10x com 8% de desconto à vista?"
  m = s.match(
    new RegExp(
      String.raw`posso comprar\s+(?:uma?\s+|o\s+|a\s+)?(.+?)\s+(?:de|por)\s+${AMOUNT}(?:\s+em\s+(\d{1,2})\s*x)?(?:.*?(\d{1,2})\s*%\s*de desconto)?`,
    ),
  );
  if (m)
    return {
      name: 'evaluate_purchase',
      input: {
        description: cap(m[1]!),
        price: m[2]!,
        installments: m[3] ? Number(m[3]) : null,
        cash_discount_pct: m[4] ? Number(m[4]) : null,
      },
    };
  if (
    /renda (?:ja )?(?:esta )?comprometida|comprometid\w* (?:com|em) parcelas|quanto da (?:minha )?renda|quando (?:minhas |as )?parcelas (?:acabam|terminam)|parcelando demais/.test(
      s,
    )
  )
    return { name: 'get_income_commitment', input: {} };
  if (/quanto (?:eu )?posso gastar|tenho folga/.test(s)) return { name: 'get_safe_to_spend', input: {} };
  if (/reserva de emergencia|sem salario|demitid|desligad|perder o emprego/.test(s))
    return { name: 'get_emergency_reserve', input: {} };

  // aposentadoria: "nasci em 15/03/1985", "se eu aposentar em 2040, quanto recebo?", "aos 60 anos"
  m = s.match(/^nasci em\s+(\S+)/);
  if (m) return { name: 'draft_retirement_profile', input: { birth_date: m[1] } };
  if (/aposent/.test(s)) {
    const year = s.match(/aposent\w*\s+(?:em|no ano de)\s+(\d{4})/)?.[1];
    const age = s.match(/aposent\w*\s+(?:aos|com)\s+(\d{2})\s+anos/)?.[1];
    return {
      name: 'retirement_scenario',
      input: {
        ...(year ? { retire_year: Number(year) } : {}),
        ...(age ? { retire_age: Number(age) } : {}),
        ...(/carteira|investimentos/.test(s) ? { include_investments: true } : {}),
      },
    };
  }

  // calendário anual: "confirma o IPVA de 2.500", "pode colocar o IPTU", "quando vem o IPVA?"
  const SEASONAL = String.raw`ipva|iptu|13[ºo]?(?: salario)?|decimo terceiro|matricula|material escolar|irpf|seguro(?: (?!de\b|em\b)[a-z]+)?`;
  m = s.match(
    new RegExp(
      String.raw`^(?:confirma|pode colocar|coloca|inclui)\s+(?:o\s+|a\s+)?(${SEASONAL})(?:\s+(?:de|em)\s+${AMOUNT})?`,
    ),
  );
  if (m)
    return {
      name: 'draft_seasonal',
      input: { action: m[2] ? 'edit' : 'confirm', item: m[1], amount: m[2] ?? null },
    };
  m = s.match(new RegExp(String.raw`^ignora\s+(?:o\s+|a\s+)?(${SEASONAL})`));
  if (m) return { name: 'draft_seasonal', input: { action: 'dismiss', item: m[1] } };
  if (
    /\b(ipva|iptu|calendario|decimo terceiro|matricula|material escolar|estoura|gastos anuais|come cotas)\b|13º/.test(
      s,
    )
  ) {
    const item = s.match(/\b(ipva|iptu|matricula|material escolar|decimo terceiro)\b|13º/)?.[0] ?? null;
    return { name: 'get_calendar', input: item ? { item } : {} };
  }

  // "quanto sobra em dezembro?"
  m = s.match(
    /quanto\s+(?:sobra|vai sobrar|fica|tenho)\s+(?:em|no fim de|no final de)\s+([a-z]+(?:\/\d{2,4}| de \d{4})?)/,
  );
  if (m) return { name: 'get_projection', input: { month: m[1] } };
  if (/projecao|proximos meses|24 meses/.test(s)) return { name: 'get_projection', input: {} };

  // "quanto gastei com mercado em setembro?"
  m = s.match(
    /quanto\s+(?:gastei|paguei)\s+(?:com|de|em)\s+(.+?)(?:\s+(?:em|no mes de)\s+([a-z]+(?:\/\d{2,4})?))?\??$/,
  );
  if (m)
    return {
      name: 'query_transactions',
      input: { category_or_text: m[1], month: m[2] ?? 'este mes', aggregate: 'sum', direction: 'out' },
    };

  // "abri uma conta no Cresol com 2.000" / "cria a conta BB com saldo 5.000"
  m = s.match(
    new RegExp(
      String.raw`(?:abri|cria|crie|cadastra|adiciona)\s+(?:uma\s+|a\s+)?conta\s+(?:corrente\s+|poupanca\s+)?(?:no\s+|na\s+|do\s+|da\s+)?(.+?)\s+com\s+(?:saldo\s+(?:de\s+)?)?${AMOUNT}`,
    ),
  );
  if (m)
    return {
      name: 'draft_account',
      input: {
        institution: m[1]!.trim(),
        name: m[1]!.trim(),
        type: /poupanca/.test(s) ? 'savings' : 'checking',
        opening_balance: m[2]!,
        opening_date: 'hoje',
      },
    };

  // "cartão Santander fecha dia 5 e vence dia 12, limite 10 mil"
  m = s.match(
    /cartao\s+(.+?)\s+(?:fecha|com fechamento)\s+(?:no\s+)?dia\s+(\d{1,2})\s+e\s+vence\s+(?:no\s+)?dia\s+(\d{1,2})(?:.*?limite\s+(?:de\s+)?(.+))?$/,
  );
  if (m)
    return {
      name: 'draft_card',
      input: {
        name: m[1]!.trim(),
        closing_day: Number(m[2]),
        due_day: Number(m[3]),
        limit: m[4] ? m[4].trim() : null,
        pay_account: null,
      },
    };

  if (/^(oi|ola|bom dia|boa tarde|boa noite)\b/.test(s)) return null;
  if (parseAmount(s) !== null) return null;
  return null;
}

function cap(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}
