import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

// Written by scripts/sync.mjs from the READMEs.
const sidebar = JSON.parse(readFileSync(new URL('./sidebar.json', import.meta.url), 'utf8')) as {
  guides: Array<{ text: string; link: string }>;
  packages: Array<{ text: string; link: string }>;
};

export default defineConfig({
  title: 'Relayo',
  description: 'Provider-agnostic email and SMS for Node.js, with one normalized event model for everything that comes back.',
  lang: 'en',
  // GitHub Pages serves the site under /relayo/; DOCS_BASE=/ for a domain of its own.
  base: process.env.DOCS_BASE ?? '/relayo/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#2f5bea' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Packages', link: '/packages/core' },
      { text: 'Platform', link: 'https://relayo.alimzen.com' },
      { text: 'API reference', link: 'https://relayo.alimzen.com/docs' },
    ],
    sidebar: [
      { text: 'Guide', items: [{ text: 'Introduction', link: '/guide/introduction' }, ...sidebar.guides] },
      { text: 'Packages', items: sidebar.packages },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Alimzen/relayo' }],
    search: { provider: 'local' },
    editLink: { pattern: 'https://github.com/Alimzen/relayo/edit/main/README.md', text: 'Edit the READMEs on GitHub' },
    footer: { message: 'MIT licensed.', copyright: '© Alimzen' },
    outline: [2, 3],
  },
});
