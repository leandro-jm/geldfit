import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });

const shot = (name: string) => fileURLToPath(new URL(`./__screenshots__/${name}.png`, import.meta.url));

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('calendário anual: detecta do histórico, confirma e aparece na projeção', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Calendário');
  const headers = { 'x-workspace-id': workspaceId };
  const now = new Date();
  const monthsAgo = (n: number, day = 10) => iso(new Date(now.getFullYear(), now.getMonth() - n, day));
  const act = async (kind: string, payload: unknown) => {
    const res = await page.request.post('/api/actions', { headers, data: { kind, payload } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()) as { ids: string[] };
  };
  const acc = await act('account', {
    mode: 'create',
    fields: {
      institution: 'Banco do Brasil',
      name: 'BB',
      type: 'checking',
      openingBalanceCents: 2_000_000,
      openingDate: monthsAgo(14, 1),
      isPrivate: false,
    },
  });
  const accountId = acc.ids[0]!;
  // IPVA em 3 parcelas e seguro do carro, há ~10 meses
  await act('transactions', {
    source: 'manual',
    items: [
      ...[10, 9, 8].map((n, i) => ({
        accountId,
        date: monthsAgo(n),
        direction: 'out',
        amountCents: 78_000,
        description: `IPVA parcela ${i + 1}/3`,
      })),
      {
        accountId,
        date: monthsAgo(9, 20),
        direction: 'out',
        amountCents: 150_000,
        description: 'IPTU cota única',
      },
    ],
  });
  const det = await page.request.post('/api/calendar/detect', { headers });
  expect(det.ok(), await det.text()).toBeTruthy();

  await page.goto('/calendario');
  const toConfirm = page.locator('section[aria-labelledby="sea-confirm"]');
  await expect(toConfirm).toContainText('IPVA');
  await expect(toConfirm).toContainText('R$ 2.340,00 em 3 parcelas');
  await expect(toConfirm).toContainText('IPTU');
  await page.screenshot({ path: shot('1280-light-calendario'), fullPage: true });

  const ipvaRow = toConfirm.locator('div.flex', { hasText: 'IPVA' }).first();
  await ipvaRow.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Calendário atualizado.')).toBeVisible();
  const next = page.locator('section[aria-labelledby="sea-next"]');
  await expect(next.locator('li', { hasText: 'IPVA (1/3)' }).getByText('na projeção')).toBeVisible();
  await expect(next.locator('li', { hasText: 'IPTU' }).getByText('sugerido')).toBeVisible();

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(next).toBeVisible();
  await page.screenshot({ path: shot('1280-dark-calendario'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  // Projeção: o mês da 1ª parcela tem a marca; o detalhe separa incluído de não incluído
  await page.goto('/projecao');
  const row = page
    .locator('tr')
    .filter({ has: page.getByRole('img', { name: /Calendário anual: .*IPVA/ }) })
    .first();
  await expect(row).toBeVisible();
  await row.click();
  const detail = page.getByTestId('month-detail');
  await expect(detail).toContainText('Calendário anual');
  await expect(detail).toContainText('na projeção');
  await detail.screenshot({ path: shot('1280-light-projecao-calendario') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/calendario');
  await expect(page.locator('section[aria-labelledby="sea-next"]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: shot('390-light-calendario'), fullPage: true });

  expect(errs).toEqual([]);
});
