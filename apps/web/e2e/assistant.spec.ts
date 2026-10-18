import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders } from './helpers';
test.use({ extraHTTPHeaders: clientHeaders() });

test('assistente: anotar, editar, restaurar arquivada, apagar e salvar perfil', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Memória');
  // fato sensível já arquivado (aparece em "Ver arquivadas")
  const pending = await page.request.post('/api/memories', {
    data: { content: 'Tem diabetes tipo 2', category: 'perfil', sensitive: true },
    headers: { 'x-workspace-id': workspaceId },
  });
  expect(pending.ok()).toBeTruthy();
  const { id } = (await pending.json()) as { id: string };
  await page.request.patch(`/api/memories/${id}`, {
    data: { action: 'archive' },
    headers: { 'x-workspace-id': workspaceId },
  });

  await page.goto('/assistente');
  await expect(page.getByRole('heading', { name: 'Assistente', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'O que sei sobre você' }).click();
  await expect(page.getByText('Ainda não sei nada sobre você')).toBeVisible();

  await page.getByRole('button', { name: 'Anotar' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('O que lembrar').fill('Quero trocar de carro em 2027');
  await dialog.getByLabel('Tipo').selectOption('objetivo');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  const item = page.getByTestId('memory-item').filter({ hasText: 'trocar de carro' });
  await expect(item).toBeVisible();

  await item.getByRole('button', { name: 'Editar' }).click();
  await dialog.getByLabel('O que lembrar').fill('Quero trocar de carro em 2028');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByTestId('memory-item').filter({ hasText: '2028' })).toBeVisible();

  // arquivada aparece no histórico e pode voltar
  await page.getByRole('button', { name: /Ver arquivadas/ }).click();
  const archived = page.getByTestId('memory-item').filter({ hasText: 'diabetes' });
  await archived.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByText('Restaurado.')).toBeVisible();

  await page
    .getByTestId('memory-item')
    .filter({ hasText: '2028' })
    .getByRole('button', { name: 'Apagar' })
    .click();
  await expect(page.getByTestId('memory-item').filter({ hasText: '2028' })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Perfil e proatividade' }).click();
  await page.getByLabel('Fase de vida').selectOption('familia_filhos');
  await page.getByLabel('Dependentes').fill('2');
  await page.getByRole('group', { name: 'Objetivos' }).getByRole('button', { name: 'Viajar' }).click();
  await page
    .getByRole('group', { name: 'O que acompanhar' })
    .getByRole('button', { name: 'Selic e juros' })
    .click();
  await page.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(page.getByText('Perfil salvo.')).toBeVisible();
  const profile = await (
    await page.request.get('/api/profile', { headers: { 'x-workspace-id': workspaceId } })
  ).json();
  expect(profile).toMatchObject({
    lifeStage: 'familia_filhos',
    dependents: 2,
    objectives: ['viagem'],
    interests: ['selic'],
  });
  expect(errs).toEqual([]);
});

test('caixa do assistente: meta atrasada vira prévia, confirma e responde pergunta de perfil', async ({
  page,
}) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const { workspaceId } = await apiSignUp(page.request, 'Caixa');
  const year = new Date().getFullYear() + 1;
  const goal = await page.request.post('/api/actions', {
    data: {
      kind: 'goal',
      payload: {
        mode: 'create',
        fields: {
          name: 'Intercâmbio',
          kind: 'travel',
          targetCents: 3_000_000,
          savedCents: 0,
          monthlyContributionCents: 10_000,
          startMonth: `${year - 1}-01-01`,
          targetDate: `${year}-12-31`,
        },
      },
    },
    headers: { 'x-workspace-id': workspaceId },
  });
  expect(goal.ok()).toBeTruthy();

  await page.goto('/assistente');
  const card = page.getByTestId('nudge-card').filter({ hasText: 'Meta Intercâmbio atrasada' });
  await expect(card).toBeVisible();
  await expect(page.getByTestId('assistant-bell')).toHaveAccessibleName(/Assistente: \d+ sugest/);
  await card.getByRole('button', { name: 'Ver prévia' }).click();
  await expect(card.getByTestId('nudge-preview')).toContainText('Meta: Intercâmbio');
  await card.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Meta salva.')).toBeVisible();
  await expect(card).toHaveCount(0);

  const question = page.getByTestId('nudge-card').filter({ hasText: 'tipo de renda' });
  await question.getByRole('button', { name: 'Autônomo' }).click();
  await expect(page.getByText(/Anotado: autônomo/)).toBeVisible();
  const profile = await (
    await page.request.get('/api/profile', { headers: { 'x-workspace-id': workspaceId } })
  ).json();
  expect(profile.incomeStability).toBe('autonomo');

  await page.getByRole('button', { name: /Ver histórico/ }).click();
  await expect(page.getByRole('list', { name: 'Histórico de sugestões' })).toContainText('aceita');
  expect(errs).toEqual([]);
});
