import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders } from './helpers';

test.use({ extraHTTPHeaders: clientHeaders() });

const SHOT = fileURLToPath(new URL('./__screenshots__/1280-light-chat-import-draft.png', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/extrato.csv', import.meta.url));

test('importar extrato CSV pelo chat gera prévia em lote e confirma', async ({ page }) => {
  const { workspaceId } = await apiSignUp(page.request, 'Carlos Import');
  const acc = await page.request.post('/api/actions', {
    headers: { 'x-workspace-id': workspaceId },
    data: {
      kind: 'account',
      payload: {
        mode: 'create',
        fields: {
          institution: 'Banco do Brasil',
          name: 'BB',
          type: 'checking',
          openingBalanceCents: 100_000,
          openingDate: '2026-09-01',
          isPrivate: false,
        },
      },
    },
  });
  expect(acc.ok()).toBeTruthy();

  await page.goto('/');
  const chat = page.getByTestId('chat-panel');
  await expect(chat).toBeVisible();
  await chat.locator('input[type=file][multiple]').setInputFiles(FIXTURE);
  await expect(chat.getByTestId('pending-attachment')).toContainText('extrato.csv');
  // espera o upload terminar (o botão Enviar só habilita depois)
  const input = chat.getByLabel('Mensagem para o assistente');
  await input.fill('importa esse extrato do BB');
  await expect(chat.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await chat.getByRole('button', { name: 'Enviar' }).click();

  const draft = chat.getByTestId('draft-card').last();
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await expect(draft).toHaveAttribute('data-status', 'pending');
  await expect(draft.getByTestId('draft-totals')).toContainText('5 lançamentos');
  await chat.screenshot({ path: SHOT });
  await draft.getByRole('button', { name: 'Confirmar' }).click();
  await expect(draft).toHaveAttribute('data-status', 'confirmed');

  await page.goto('/lancamentos');
  await expect(page.getByTestId('tx-table')).toContainText('Supermercado Angeloni');
});

test('revisão da importação: desmarcar um item, salvar (PATCH) e confirmar', async ({ page }) => {
  const { workspaceId } = await apiSignUp(page.request, 'Dora Revisão');
  const acc = await page.request.post('/api/actions', {
    headers: { 'x-workspace-id': workspaceId },
    data: {
      kind: 'account',
      payload: {
        mode: 'create',
        fields: {
          institution: 'Banco do Brasil',
          name: 'BB',
          type: 'checking',
          openingBalanceCents: 100_000,
          openingDate: '2026-09-01',
          isPrivate: false,
        },
      },
    },
  });
  expect(acc.ok()).toBeTruthy();
  await page.goto('/');
  const chat = page.getByTestId('chat-panel');
  await chat.locator('input[type=file][multiple]').setInputFiles(FIXTURE);
  await chat.getByLabel('Mensagem para o assistente').fill('importa esse extrato do BB');
  await expect(chat.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  await chat.getByRole('button', { name: 'Enviar' }).click();
  const draft = chat.getByTestId('draft-card').last();
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await draft.getByRole('link', { name: 'Revisar itens' }).click();

  await expect(page.getByRole('heading', { name: 'Revisar importação' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Incluir Netflix' }).click();
  await page.getByRole('button', { name: 'Importar 4' }).click();
  await expect(page).toHaveURL(/\/lancamentos$/);
  const table = page.getByTestId('tx-table');
  await expect(table).toContainText('Posto Shell');
  await expect(table).not.toContainText('Netflix');
});
