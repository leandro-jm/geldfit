import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders } from './helpers';

test.use({ extraHTTPHeaders: clientHeaders() });

test('PWA: manifest, service worker e seção "App e notificações"', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));

  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
    display: string;
    icons: Array<{ purpose?: string }>;
  };
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);

  await apiSignUp(page.request, 'Pwa');
  await page.goto('/configuracoes');
  const section = page.locator('#app');
  await expect(section.getByRole('heading', { name: 'App e notificações' })).toBeVisible();
  await expect(section.getByText('Instalar o app')).toBeVisible();
  await expect(section.getByText('Notificações neste aparelho')).toBeVisible();
  await expect
    .poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())))
    .toBe(true);
  expect(errs).toEqual([]);
});
