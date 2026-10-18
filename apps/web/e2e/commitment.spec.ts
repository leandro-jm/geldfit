import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });

const shot = (name: string) => fileURLToPath(new URL(`./__screenshots__/${name}.png`, import.meta.url));

test('renda comprometida: painel no dashboard e gráfico na resposta do chat', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Parcelas');
  await seedWorkspace(page.request, workspaceId);
  const headers = { 'x-workspace-id': workspaceId };
  const cards = (await (await page.request.get('/api/cards', { headers })).json()) as Array<{ id: string }>;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const res = await page.request.post('/api/actions', {
    headers,
    data: {
      kind: 'transactions',
      payload: {
        source: 'manual',
        items: [
          {
            cardId: cards[0]!.id,
            date: today,
            direction: 'out',
            amountCents: 360_000,
            description: 'TV',
            installments: 10,
          },
          {
            cardId: cards[0]!.id,
            date: today,
            direction: 'out',
            amountCents: 90_000,
            description: 'Celular',
            installments: 3,
          },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  await page.goto('/');
  const head = page.getByTestId('commitment-head');
  await expect(head).toContainText(/\d+%/);
  await expect(head).toContainText('já está comprometida com parcelas');
  await expect(head).toContainText('Em ');
  await expect(page.getByTestId('commitment-status')).toBeVisible();
  const panel = page.locator('section[aria-labelledby="commitment-title"]');
  await page.waitForTimeout(600); // animação das barras
  await panel.screenshot({ path: shot('1280-light-renda-comprometida') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(head).toBeVisible();
  await page.waitForTimeout(600); // animação das barras
  await panel.screenshot({ path: shot('1280-dark-renda-comprometida') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();

  const chat = page.getByTestId('chat-panel');
  const input = chat.getByLabel('Mensagem para o assistente');
  await input.fill('quanto da minha renda está comprometida?');
  await input.press('Enter');
  await expect(chat.getByTestId('chat-visual').last()).toBeVisible();
  await expect(chat.getByTestId('chat-visual').last()).toContainText('Renda comprometida com parcelas');

  await input.fill('posso comprar uma geladeira de 2.400 em 12x');
  await input.press('Enter');
  const compare = chat.getByTestId('chat-visual').last();
  await expect(compare).toContainText('antes × com a compra');
  await expect(compare).toContainText('Esta compra');
  await expect(chat.getByText(/a renda comprometida com parcelas sobe de \d+% para \d+%/)).toBeVisible();
  await compare.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('1280-light-chat-compra-parcelada') });

  // o gráfico volta com o histórico
  await page.reload();
  await expect(page.getByTestId('chat-panel').getByTestId('chat-visual')).toHaveCount(2);
  expect(errs).toEqual([]);
});
