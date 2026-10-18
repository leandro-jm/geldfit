import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Site estático (HTML pronto para buscadores). As URLs entram no build: mudou, rebuild.
const SITE_URL = (process.env.SITE_URL || 'http://localhost:4400').replace(/\/$/, '');

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'ignore',
  compressHTML: true,
  build: { inlineStylesheets: 'always' },
  image: { responsiveStyles: true },
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
});
