import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { clientHeaders, PASSWORD, randomEmail } from './helpers';

test.use({ extraHTTPHeaders: clientHeaders() });

test.describe('chat → dashboard ao vivo', () => {
  test('cadastro, consentimento, conta e despesa pelo chat atualizam os KPIs sem recarregar', async ({
    page,
  }) => {
    const email = randomEmail('chat');
    await page.goto('/cadastro');
    await page.getByLabel('Nome').fill('Bruna Chat');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(PASSWORD);
    await page.getByRole('button', { name: 'Criar conta' }).click();

    // Consentimento LGPD
    await expect(page.getByRole('heading', { name: 'Antes de começar' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Concordo com os termos' }).click();
    await page.getByRole('button', { name: 'Concordar e continuar' }).click();

    // Painel vazio com dica de onboarding e chat lateral
    await expect(page.getByTestId('onboarding')).toBeVisible();
    const chat = page.getByTestId('chat-panel');
    await expect(chat).toBeVisible();
    const kpi = page.getByTestId('kpi-accounts');
    await expect(kpi).toContainText('R$ 0,00');

    // 1) conta pelo chat → prévia → confirmar
    const input = chat.getByLabel('Mensagem para o assistente');
    await input.fill('abri uma conta no BB com 5.000');
    await input.press('Enter');
    const draft1 = chat.getByTestId('draft-card').last();
    await expect(draft1).toHaveAttribute('data-status', 'pending');
    await expect(draft1).toContainText('BB');
    await draft1.getByRole('button', { name: 'Confirmar' }).click();
    await expect(draft1).toHaveAttribute('data-status', 'confirmed');
    await expect(kpi).toContainText('R$ 5.000,00', { timeout: 5_000 });

    // 2) despesa pelo chat
    await input.fill('paguei 230 de luz no BB hoje');
    await input.press('Enter');
    const draft2 = chat.getByTestId('draft-card').nth(1);
    await expect(draft2).toHaveAttribute('data-status', 'pending');
    await expect(draft2).toContainText('230');
    await draft2.getByRole('button', { name: 'Confirmar' }).click();
    await expect(kpi).toContainText('R$ 4.770,00', { timeout: 5_000 });
    await page.screenshot({
      path: fileURLToPath(new URL('./__screenshots__/1280-light-chat-flow.png', import.meta.url)),
    });

    // 3) escrita vinda de outro cliente (API) chega pelo SSE /api/events em até 5 s
    const me = (await (await page.request.get('/api/me')).json()) as { workspaces: Array<{ id: string }> };
    const ws = me.workspaces[0]!.id;
    const accounts = (await (
      await page.request.get('/api/accounts', { headers: { 'x-workspace-id': ws } })
    ).json()) as Array<{ id: string }>;
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await page.request.post('/api/actions', {
      headers: { 'x-workspace-id': ws },
      data: {
        kind: 'transactions',
        payload: {
          items: [
            {
              accountId: accounts[0]!.id,
              date,
              amountCents: 1_000,
              direction: 'out',
              description: 'Café (outro dispositivo)',
            },
          ],
        },
      },
    });
    expect(res.ok()).toBeTruthy();
    await expect(kpi).toContainText('R$ 4.760,00', { timeout: 5_000 });
  });
});
