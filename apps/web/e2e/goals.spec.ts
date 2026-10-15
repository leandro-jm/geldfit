import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });

test('meta com prazo: aporte recomendado no formulário e no cartão; "Usar" deixa em dia', async ({
  page,
}) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Metas');
  await seedWorkspace(page.request, workspaceId);
  const year = new Date().getFullYear() + 1;

  await page.goto('/metas');
  await page.getByRole('button', { name: 'Nova meta' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome').fill('Orlando');
  await dialog.getByLabel('Tipo').selectOption('travel');
  await dialog.getByLabel('Valor alvo (R$)').fill('30.000');
  await dialog.getByLabel('Aporte mensal (R$)').fill('1.000');
  await dialog.getByLabel('Data alvo').fill(`${year}-08-31`);
  // o formulário já mostra quanto aportar para o prazo
  await expect(dialog.getByRole('button', { name: /Para o prazo: R\$ [\d.,]+\/mês \(usar\)/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(dialog).toBeHidden();

  const card = page.getByRole('listitem').filter({ hasText: 'Orlando' });
  const advice = card.getByTestId('goal-advice');
  await expect(advice).toContainText(new RegExp(`Para chegar até 31/08/${year}, aporte R\\$ [\\d.,]+/mês`));
  await page.screenshot({
    path: fileURLToPath(new URL('./__screenshots__/metas-recomendacao.png', import.meta.url)),
  });

  await advice.getByRole('button', { name: /^Usar/ }).click();
  await expect(page.getByText(/Aporte de R\$ [\d.,]+\/mês salvo\./)).toBeVisible();
  await expect(card.getByTestId('goal-advice')).toContainText('Em dia: conclui em');
  expect(errs).toEqual([]);
});
