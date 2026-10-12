import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';

const headers = clientHeaders();

test.describe.configure({ mode: 'serial' });
let storage: string | undefined;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', extraHTTPHeaders: headers });
  const page = await ctx.newPage();
  const { workspaceId } = await apiSignUp(page.request, 'Ivo Acessível');
  await seedWorkspace(page.request, workspaceId);
  storage = fileURLToPath(new URL('./__screenshots__/.state-a11y.json', import.meta.url));
  await ctx.storageState({ path: storage });
  await ctx.close();
});

const PAGES = [
  { name: 'Painel', path: '/', ready: 'kpi-accounts' },
  { name: 'Lançamentos', path: '/lancamentos', ready: 'tx-table' },
];

for (const scheme of ['light', 'dark'] as const) {
  for (const pg of PAGES) {
    test(`axe: ${pg.name} (${scheme}) sem violações sérias/críticas`, async ({ browser }) => {
      const ctx = await browser.newContext({
        baseURL: 'http://localhost:5173',
        storageState: storage,
        extraHTTPHeaders: headers,
        colorScheme: scheme,
        viewport: { width: 1280, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(pg.path);
      await expect(page.getByTestId(pg.ready)).toBeVisible();
      await expect(page.locator('[aria-busy=true]')).toHaveCount(0, { timeout: 15_000 });
      await page.waitForTimeout(800); // animações de entrada
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      const summary = bad
        .map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
              .slice(0, 5)
              .map((n) => n.target.join(' ') + ' — ' + (n.failureSummary ?? '').replace(/\n/g, ' '))
              .join('\n  ')}`,
        )
        .join('\n');
      expect(bad, summary).toEqual([]);
      await ctx.close();
    });
  }
}
