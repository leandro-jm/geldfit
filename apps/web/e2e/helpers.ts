import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'senha-forte-123';

/** Cabeçalhos extras por contexto. O rate limit da API é por sessão, então nada é necessário. */
export function clientHeaders(): Record<string, string> {
  return {};
}

export function randomEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@exemplo.com`;
}

/** Cadastra um usuário pela API (cookies ficam no contexto do navegador) e aceita o consentimento. */
export async function apiSignUp(
  request: APIRequestContext,
  name = 'Ana Teste',
): Promise<{ email: string; workspaceId: string }> {
  const email = randomEmail();
  const res = await request.post('/api/auth/sign-up/email', {
    data: { email, password: PASSWORD, name },
    headers: { origin: 'http://localhost:5173' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const c = await request.post('/api/me/consent', { data: { terms: true, privacy: true, llm: true } });
  expect(c.ok()).toBeTruthy();
  const me = (await (await request.get('/api/me')).json()) as { workspaces: Array<{ id: string }> };
  return { email, workspaceId: me.workspaces[0]!.id };
}

async function action(
  request: APIRequestContext,
  ws: string,
  kind: string,
  payload: unknown,
): Promise<{ ids: string[] }> {
  const res = await request.post('/api/actions', {
    data: { kind, payload },
    headers: { 'x-workspace-id': ws },
  });
  expect(res.ok(), `${kind}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { ids: string[] };
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Popula um workspace com conta, cartão, recorrências e lançamentos para telas com dados. */
export async function seedWorkspace(request: APIRequestContext, ws: string): Promise<void> {
  const today = new Date();
  const monthsAgo = (n: number, day = 10) => iso(new Date(today.getFullYear(), today.getMonth() - n, day));
  const acc = await action(request, ws, 'account', {
    mode: 'create',
    fields: {
      institution: 'Banco do Brasil',
      name: 'BB',
      type: 'checking',
      openingBalanceCents: 1_250_000,
      openingDate: monthsAgo(4, 1),
      isPrivate: false,
    },
  });
  const accountId = acc.ids[0]!;
  await action(request, ws, 'account', {
    mode: 'create',
    fields: {
      institution: 'Nubank',
      name: 'Nubank',
      type: 'checking',
      openingBalanceCents: 320_000,
      openingDate: monthsAgo(4, 1),
      isPrivate: false,
    },
  });
  await action(request, ws, 'card', {
    mode: 'create',
    fields: {
      name: 'Santander',
      accountId,
      last4: '4321',
      limitCents: 1_000_000,
      closingDay: 5,
      dueDay: 12,
      isPrivate: false,
    },
  });
  const cats = (await (
    await request.get('/api/categories', { headers: { 'x-workspace-id': ws } })
  ).json()) as Array<{ id: string; name: string; kind: string }>;
  const cat = (re: RegExp, kind = 'expense') =>
    cats.find((c) => c.kind === kind && re.test(c.name))?.id ?? null;
  await action(request, ws, 'recurrence', {
    mode: 'create',
    fields: {
      description: 'Salário',
      amountCents: 850_000,
      direction: 'in',
      accountId,
      categoryId: cat(/sal/i, 'income'),
      rule: 'FREQ=MONTHLY;BYMONTHDAY=5',
      startDate: monthsAgo(3, 5),
      isBill: false,
      autoPost: true,
    },
  });
  await action(request, ws, 'recurrence', {
    mode: 'create',
    fields: {
      description: 'Aluguel',
      amountCents: 280_000,
      direction: 'out',
      accountId,
      categoryId: cat(/morad|alug|casa/i),
      rule: 'FREQ=MONTHLY;BYMONTHDAY=10',
      startDate: monthsAgo(3, 10),
      isBill: true,
      autoPost: false,
    },
  });
  const items = [
    ['Supermercado Angeloni', 64_530, /mercado|aliment/i, 1],
    ['Conta de luz Celesc', 23_000, /energia|luz/i, 1],
    ['Farmácia Panvel', 8_990, /sa[uú]de|farm/i, 2],
    ['Posto Shell', 18_000, /transp|combust/i, 2],
    ['Restaurante Madero', 15_400, /aliment|restaur/i, 0],
    ['Supermercado Giassi', 51_200, /mercado|aliment/i, 0],
  ] as const;
  await action(request, ws, 'transactions', {
    items: items.map(([description, amountCents, re, ago]) => ({
      accountId,
      date: monthsAgo(ago, ago === 0 ? Math.max(1, today.getDate() - 1) : 12),
      amountCents,
      direction: 'out',
      description,
      categoryId: cat(re),
    })),
  });
}

export async function gotoApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
}

/** Página sem rolagem horizontal. */
export async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(r.sw, `${label}: scrollWidth ${r.sw} > innerWidth ${r.iw}`).toBeLessThanOrEqual(r.iw);
}
