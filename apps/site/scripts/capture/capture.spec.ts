/**
 * Capturas do app em 2x para a landing, com um usuário sintético (nada de dados reais).
 * Requer API (:4100) e web (:5173) rodando:  pnpm dev
 * Rode a partir de apps/web:  npx playwright test --config ../site/scripts/capture/playwright.config.ts
 * Depois:  pnpm --filter @sf/site shots
 */
import { expect, test } from '@playwright/test';
import { apiSignUp, seedWorkspace } from '../../../web/e2e/helpers';

const OUT = process.env.OUT ?? new URL('./out', import.meta.url).pathname;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('capturas sintéticas para a landing', async ({ page }) => {
  const { workspaceId } = await apiSignUp(page.request, 'Marina Souza');
  await seedWorkspace(page.request, workspaceId);
  const headers = { 'x-workspace-id': workspaceId };
  const act = async (kind: string, payload: unknown) => {
    const res = await page.request.post('/api/actions', { headers, data: { kind, payload } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()) as { ids: string[] };
  };
  const now = new Date();
  const monthsAgo = (n: number, day = 10) => iso(new Date(now.getFullYear(), now.getMonth() - n, day));
  const accounts = (await (await page.request.get('/api/accounts', { headers })).json()) as Array<{
    id: string;
    name: string;
  }>;
  const bb = accounts.find((a) => a.name === 'BB')!.id;
  const cards = (await (await page.request.get('/api/cards', { headers })).json()) as Array<{ id: string }>;
  await act('transactions', {
    source: 'manual',
    items: [
      ...[10, 9, 8].map((n, i) => ({
        accountId: bb,
        date: monthsAgo(n),
        direction: 'out',
        amountCents: 78_000,
        description: `IPVA parcela ${i + 1}/3`,
      })),
      {
        accountId: bb,
        date: monthsAgo(9, 20),
        direction: 'out',
        amountCents: 150_000,
        description: 'IPTU cota única',
      },
      {
        cardId: cards[0]!.id,
        date: iso(now),
        direction: 'out',
        amountCents: 360_000,
        description: 'TV',
        installments: 10,
      },
      {
        cardId: cards[0]!.id,
        date: iso(now),
        direction: 'out',
        amountCents: 90_000,
        description: 'Celular',
        installments: 3,
      },
    ],
  });
  expect((await page.request.post('/api/calendar/detect', { headers })).ok()).toBeTruthy();

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('sf.theme', t), theme);
    for (const route of ['/', '/projecao', '/calendario']) {
      await page.goto(route);
      await page.waitForLoadState('load');
      await page.waitForTimeout(2500);
      const slug = route === '/' ? 'painel' : route.slice(1);
      await page.screenshot({ path: `${OUT}/${theme}-${slug}.png`, fullPage: true });
      if (route === '/') {
        await page
          .locator('section[aria-labelledby="commitment-title"]')
          .screenshot({ path: `${OUT}/${theme}-renda.png` });
      }
    }
  }
  // celular
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('sf.theme', t), theme);
    for (const route of ['/', '/projecao']) {
      await page.goto(route);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/m-${theme}-${route === '/' ? 'painel' : 'projecao'}.png` });
    }
  }
});
