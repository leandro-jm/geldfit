import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });

test('transferência entre contas pela tela de Contas', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Transfere');
  await seedWorkspace(page.request, workspaceId);

  await page.goto('/contas');
  await page.getByRole('button', { name: 'Ações da conta Nubank' }).click();
  await page.getByRole('menuitem', { name: 'Transferir daqui' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('De').locator('option:checked')).toHaveText('Nubank');
  await expect(dialog.getByLabel('Para').locator('option', { hasText: 'Nubank' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Transferir' })).toBeDisabled();
  await dialog.getByLabel(/^Valor/).fill('150,00');
  await dialog.getByRole('button', { name: 'Transferir' }).click();
  await expect(page.getByText('Transferência registrada.')).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.goto('/lancamentos');
  const table = page.getByTestId('tx-table');
  await expect(table.getByText('Transferência Nubank → BB')).toHaveCount(2);
  await expect(table.getByText('transferência', { exact: true })).toHaveCount(2);

  // Editar a data de uma perna leva a outra junto, sem campo de categoria
  await page.getByRole('button', { name: 'Editar “Transferência Nubank → BB”' }).first().click();
  await expect(table.getByLabel('Categoria')).toHaveCount(0);
  await table.getByLabel('Descrição').fill('Reserva para viagem');
  await table.getByRole('button', { name: 'Salvar' }).click();
  await expect(table.getByText('Reserva para viagem')).toHaveCount(2);
  expect(errs, errs.join('\n')).toEqual([]);
});
