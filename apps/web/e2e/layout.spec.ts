import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { apiSignUp, clientHeaders, expectNoHorizontalScroll, seedWorkspace } from './helpers';

const SHOTS = fileURLToPath(new URL('./__screenshots__/', import.meta.url));
const VIEWPORTS = [360, 390, 768, 1280, 1440] as const;
const PAGES = [
  { name: 'painel', path: '/', ready: (p: Page) => p.getByTestId('kpi-accounts') },
  {
    name: 'lancamentos',
    path: '/lancamentos',
    ready: (p: Page) => p.getByRole('heading', { name: 'Lançamentos', level: 1 }),
  },
  {
    name: 'projecao',
    path: '/projecao',
    ready: (p: Page) => p.getByRole('heading', { name: 'Projeção', level: 1 }),
  },
  {
    name: 'configuracoes',
    path: '/configuracoes',
    ready: (p: Page) => p.getByRole('heading', { name: 'Configurações', level: 1 }),
  },
  {
    name: 'assistente',
    path: '/assistente',
    ready: (p: Page) => p.getByRole('heading', { name: 'Assistente', level: 1 }),
  },
] as const;

test.describe.configure({ timeout: 240_000 });

/** Um usuário com dados por viewport (a API limita 300 req/min por usuário). */
async function seededState(
  browser: import('@playwright/test').Browser,
  width: number,
  headers: Record<string, string>,
): Promise<string> {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', extraHTTPHeaders: headers });
  const page = await ctx.newPage();
  const { workspaceId } = await apiSignUp(page.request, 'Lia Layout');
  await seedWorkspace(page.request, workspaceId);
  const path = fileURLToPath(new URL(`./__screenshots__/.state-${width}.json`, import.meta.url));
  await ctx.storageState({ path });
  await ctx.close();
  return path;
}

for (const width of VIEWPORTS) {
  test(`layout ${width}px: sem rolagem horizontal, navegação certa e screenshots`, async ({ browser }) => {
    const height = width < 768 ? 800 : width < 1024 ? 1024 : 900;
    const headers = clientHeaders();
    const storage = await seededState(browser, width, headers);
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({
        baseURL: 'http://localhost:5173',
        storageState: storage,
        extraHTTPHeaders: headers,
        viewport: { width, height },
        colorScheme: scheme,
        locale: 'pt-BR',
        hasTouch: width < 1024,
        isMobile: width < 768,
      });
      const page = await ctx.newPage();
      for (const pg of PAGES) {
        await page.goto(pg.path);
        await expect(pg.ready(page)).toBeVisible();
        await expect(page.locator('[aria-busy=true]')).toHaveCount(0, { timeout: 15_000 });
        await page.waitForTimeout(400);
        await expectNoHorizontalScroll(page, `${pg.name}@${width}/${scheme}`);

        if (width === 360) {
          await expect(page.getByTestId('bottom-tabs')).toBeVisible();
          await expect(page.getByTestId('sidebar')).toHaveCount(0);
          await expect(page.getByTestId('mobile-chat-bar')).toBeVisible();
        }
        if (width >= 1280) {
          await expect(page.getByTestId('sidebar')).toBeVisible();
          await expect(page.getByTestId('chat-panel')).toBeVisible();
          await expect(page.getByTestId('bottom-tabs')).toHaveCount(0);
        }
        if (width === 768) {
          await expect(page.getByTestId('sidebar')).toBeVisible();
          await expect(page.getByTestId('chat-fab')).toBeVisible();
        }
        await page.screenshot({ path: `${SHOTS}${width}-${scheme}-${pg.name}.png`, fullPage: true });
      }

      // chat em cada tamanho
      await page.goto('/');
      await expect(page.getByTestId('kpi-accounts')).toBeVisible();
      if (width < 768) {
        await page.getByTestId('mobile-chat-bar').click();
        await expect(page).toHaveURL(/\/chat$/);
      } else if (width < 1024) {
        await page.getByTestId('chat-fab').click();
      }
      const chat = page.getByTestId('chat');
      await expect(chat).toBeVisible();
      await expect(chat.getByLabel('Mensagem para o assistente')).toBeVisible();
      await page.waitForTimeout(300);
      await expectNoHorizontalScroll(page, `chat@${width}/${scheme}`);
      await page.screenshot({ path: `${SHOTS}${width}-${scheme}-chat.png` });
      await ctx.close();
    }
  });
}
