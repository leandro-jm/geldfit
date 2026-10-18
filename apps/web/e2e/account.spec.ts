import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders } from './helpers';

test.use({ extraHTTPHeaders: clientHeaders() });

test('minha conta: troca nome e e-mail em Configurações', async ({ page }) => {
  await apiSignUp(page.request, 'Demo');
  await page.goto('/configuracoes');

  const section = page.locator('#conta');
  await expect(section.getByRole('heading', { name: 'Minha conta' })).toBeVisible();
  await expect(section.getByText('não verificado')).toBeVisible();

  await section.getByLabel('Nome').fill('Leandro Martins');
  await section.getByRole('button', { name: 'Salvar nome' }).click();
  await expect(page.getByText('Nome atualizado.')).toBeVisible();
  await expect(section.locator('p', { hasText: 'Leandro Martins' }).first()).toBeVisible();

  const email = `novo-${Date.now()}@exemplo.com`;
  await section.getByLabel('E-mail').fill(email);
  await section.getByRole('button', { name: 'Trocar e-mail' }).click();
  await expect(page.getByText(/E-mail atualizado/)).toBeVisible();
  const me = (await (await page.request.get('/api/me')).json()) as { user: { name: string; email: string } };
  expect(me.user).toMatchObject({ name: 'Leandro Martins', email });

  await expect(section.getByLabel('Senha atual')).toBeVisible();
  await page.screenshot({
    path: fileURLToPath(new URL('./__screenshots__/1280-light-account.png', import.meta.url)),
  });
});
