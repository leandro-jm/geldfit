// Gera os ícones PNG do PWA a partir do SVG do logo (usa o Chromium do Playwright).
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const mark = (size, pad) => {
  const inner = size - pad * 2;
  const s = inner / 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${pad ? `<rect width="${size}" height="${size}" fill="#2563c4"/>` : ''}
  <g transform="translate(${pad} ${pad}) scale(${s})">
    ${pad ? '' : '<rect width="32" height="32" rx="7" fill="#2563c4"/>'}
    <path d="M8 20.5l5-5 4 3.5 7-8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="24" cy="11" r="2" fill="#fff"/>
  </g></svg>`;
};
const targets = [
  ['pwa-192.png', 192, 0],
  ['pwa-512.png', 512, 0],
  ['pwa-maskable-512.png', 512, 96],
  ['apple-touch-icon.png', 180, 24],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${mark(size, pad)}</body></html>`,
  );
  await page.locator('svg').screenshot({ path: join(pub, name), omitBackground: true });
  console.log('ok', name);
}
await browser.close();
