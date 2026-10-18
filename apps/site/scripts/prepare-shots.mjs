// Recorta as capturas do app para a landing e gera a imagem de compartilhamento (og-image).
// Fontes: scripts/capture/out (2x, usuário sintético) e apps/web/e2e/__screenshots__ (1x, e2e).
// Uso: pnpm --filter @sf/site shots
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CAP = here('./capture/out/');
const E2E = here('../../web/e2e/__screenshots__/');
const OUT = here('../src/assets/screens/');
const PUBLIC = here('../public/');

/** [saída, origem, recorte {left, top, width, height} | null] */
const jobs = [];
for (const t of ['light', 'dark']) {
  jobs.push(
    [`projecao-${t}`, `${CAP}${t}-projecao.png`, { left: 0, top: 0, width: 1760, height: 1900 }],
    [`projecao-grafico-${t}`, `${CAP}${t}-projecao.png`, { left: 176, top: 890, width: 1560, height: 1000 }],
    [`renda-${t}`, `${CAP}${t}-renda.png`, null],
    [`calendario-${t}`, `${CAP}${t}-calendario.png`, { left: 144, top: 128, width: 1616, height: 1180 }],
    [`painel-mobile-${t}`, `${CAP}m-${t}-painel.png`, { left: 0, top: 0, width: 780, height: 1520 }],
    [`assistente-${t}`, `${E2E}1280-${t}-assistente.png`, { left: 72, top: 64, width: 808, height: 600 }],
  );
}
jobs.push(
  ['previa-chat', `${E2E}1280-light-chat-import-draft.png`, null],
  [
    'cabe-no-bolso',
    `${E2E}1280-light-chat-compra-parcelada.png`,
    { left: 880, top: 56, width: 400, height: 690 },
  ],
);

await mkdir(OUT, { recursive: true });
for (const [name, src, crop] of jobs) {
  let img = sharp(src);
  if (crop) img = img.extract(crop);
  const info = await img.png({ compressionLevel: 9 }).toFile(`${OUT}${name}.png`);
  console.log(`${name}.png  ${info.width}x${info.height}`);
}

// og-image 1200x630: fundo na cor do produto, título e a tela de projeção à direita
const W = 1200;
const H = 630;
const shot = await sharp(`${OUT}projecao-light.png`)
  .extract({ left: 144, top: 0, width: 1616, height: 1300 })
  .resize({ width: 620 })
  .png()
  .toBuffer();
const shotMeta = await sharp(shot).metadata();
const mask = Buffer.from(
  `<svg width="${shotMeta.width}" height="${shotMeta.height}"><rect width="100%" height="100%" rx="18" fill="#fff"/></svg>`,
);
const rounded = await sharp(shot)
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer();
const bg = Buffer.from(`
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1c4f9c"/><stop offset="1" stop-color="#2563c4"/>
    </linearGradient>
    <radialGradient id="r" cx="0.85" cy="0.1" r="0.7">
      <stop offset="0" stop-color="#5b9cea" stop-opacity="0.55"/><stop offset="1" stop-color="#5b9cea" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect width="100%" height="100%" fill="url(#r)"/>
  <g transform="translate(64 64)">
    <rect width="56" height="56" rx="16" fill="#fff"/>
    <path d="M14 36l9-9 7 6 12-14" fill="none" stroke="#2563c4" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="42" cy="19.5" r="3.5" fill="#2563c4"/>
    <text x="74" y="38" font-family="Inter, Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="#fff">Saúde Financeira</text>
  </g>
  <text font-family="Inter, Helvetica, Arial, sans-serif" font-weight="800" fill="#fff" font-size="52" letter-spacing="-1.5">
    <tspan x="64" y="250">Saiba hoje quanto</tspan>
    <tspan x="64" y="312">vai sobrar nos</tspan>
    <tspan x="64" y="374">próximos 24 meses.</tspan>
  </text>
  <text font-family="Inter, Helvetica, Arial, sans-serif" font-size="24" fill="#dbe7fa">
    <tspan x="64" y="450">Planejamento financeiro por chat,</tspan>
    <tspan x="64" y="484">no WhatsApp e na web.</tspan>
  </text>
</svg>`);
await sharp(bg)
  .composite([{ input: rounded, left: W - shotMeta.width + 40, top: 150 }])
  .png({ compressionLevel: 9 })
  .toFile(`${PUBLIC}og-image.png`);
console.log('public/og-image.png  1200x630');
