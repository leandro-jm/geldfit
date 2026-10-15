import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });

test('lançamento avulso pela tela de Lançamentos', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Avulso');
  await seedWorkspace(page.request, workspaceId);

  await page.goto('/lancamentos');
  await page.getByRole('button', { name: 'Novo lançamento' }).click();
  const dialog = page.getByRole('dialog');
  const save = dialog.getByRole('button', { name: 'Salvar', exact: true });
  await expect(save).toBeDisabled();

  // Saída na conta, categoria automática pela descrição; "lançar outro" mantém a janela aberta
  await dialog.getByLabel('Descrição').fill('Padaria do Zé');
  await dialog.getByLabel(/^Valor/).fill('23,90');
  await dialog.getByRole('button', { name: 'Salvar e lançar outro' }).click();
  await expect(page.getByText('Lançamento registrado.')).toBeVisible();
  await expect(dialog.getByLabel('Descrição')).toHaveValue('');

  // Entrada: a categoria passa a listar as de receita
  await dialog.getByRole('button', { name: 'Entrada' }).click();
  await dialog.getByLabel('Descrição').fill('Freela site');
  await dialog.getByLabel(/^Valor/).fill('1.200,00');
  await save.click();
  await expect(dialog).toBeHidden();

  const table = page.getByTestId('tx-table');
  await expect(table.getByRole('row', { name: /Padaria do Zé/ })).toContainText('Mercado');
  await expect(table.getByRole('row', { name: /Freela site/ })).toContainText('1.200,00');

  // Compra parcelada no cartão
  await page.getByRole('button', { name: 'Novo lançamento' }).click();
  await dialog.getByLabel('Descrição').fill('Geladeira');
  await dialog.getByLabel('Conta ou cartão').selectOption({ label: 'Cartão Santander' });
  await dialog.getByLabel('Parcelas').selectOption('3');
  await expect(dialog.getByLabel(/^Valor total/)).toBeVisible();
  await dialog.getByLabel(/^Valor total/).fill('3.000,00');
  await save.click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Todos', exact: true }).click();
  await page.getByLabel('Buscar').fill('Geladeira');
  await expect(table.getByText(/^Geladeira \(\d\/3\)$/)).toHaveCount(3);
  expect(errs, errs.join('\n')).toEqual([]);
});
