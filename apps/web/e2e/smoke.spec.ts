import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });
test.describe.configure({ timeout: 120_000 });
test('smoke: todas as telas sem erros no console; perguntar sobre um painel; edição inline', async ({
  page,
}) => {
  const errs: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Console');
  await seedWorkspace(page.request, workspaceId);
  for (const p of [
    '/',
    '/projecao',
    '/lancamentos',
    '/contas',
    '/carteira',
    '/recorrencias',
    '/metas',
    '/previdencia',
    '/importacoes',
    '/configuracoes',
  ]) {
    await page.goto(p);
    await expect(page.locator('h1')).toBeVisible();
    await page.waitForTimeout(700);
  }
  await page.goto('/');
  await page.getByRole('button', { name: /Perguntar sobre isto: Projeção/ }).click();
  await expect(page.getByLabel('Mensagem para o assistente')).toHaveValue(/projeção/i);
  await page.getByLabel('Mensagem para o assistente').press('Enter');
  await page.waitForTimeout(2500);
  await page.goto('/lancamentos');
  await page.getByRole('button', { name: /Editar “Posto Shell”/ }).click();
  await page.getByLabel('Descrição').first().fill('Posto Shell BR-101');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByTestId('tx-table')).toContainText('Posto Shell BR-101');
  expect(errs, errs.join('\n')).toEqual([]);
});
