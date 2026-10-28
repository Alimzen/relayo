// Builds the site's pages from the READMEs, so the docs never drift from them: the root README is the
// introduction, each section of the core's README a guide page, and each package's README its own page.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');
const GITHUB = 'https://github.com/Alimzen/relayo/blob/main';

const slug = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Vue reads {{ }} in prose as an expression: escape it outside code (fences and inline code stay as they are). */
function escapeMustaches(markdown) {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 ? part : part.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;')))
        .join('');
    })
    .join('\n');
}

/** Links between READMEs become links between pages; links to other files go to GitHub. */
function rewriteLinks(markdown, from) {
  return markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (whole, target) => {
    const [path, hash = ''] = target.split('#');
    const resolved = join(from, path).replace(/\\/g, '/').replace(/\/$/, '');
    const anchor = hash ? `#${hash}` : '';
    const pkg = /^packages\/([^/]+)(\/README\.md)?$/.exec(resolved);
    if (pkg) return `](/packages/${pkg[1]}${anchor})`;
    if (/^actions\/sim(\/README\.md)?$/.test(resolved)) return `](/packages/action-sim${anchor})`;
    if (resolved === 'README.md' || resolved === '') return `](/guide/introduction${anchor})`;
    return `](${GITHUB}/${resolved}${anchor})`;
  });
}

const page = (markdown, from) => escapeMustaches(rewriteLinks(markdown, from));

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// Generated folders start empty each time.
for (const dir of ['guide', 'packages']) await rm(join(site, dir), { recursive: true, force: true });

// Introduction: the root README without its development notes.
const root = await readFile(join(repo, 'README.md'), 'utf8');
const intro = root.replace(/\n## Development[\s\S]*$/, '\n');
await write(join(site, 'guide', 'introduction.md'), page(intro.replace(/^# Relayo/, '# Introduction'), ''));

// Guides: the core's README, one page per section.
const core = await readFile(join(repo, 'packages', 'core', 'README.md'), 'utf8');
const [head, ...sections] = core.split(/\n(?=## )/);
const guides = [];
await write(join(site, 'guide', 'installation.md'), page(head.replace(/^# .*/, '# Installation'), 'packages/core'));
guides.push({ text: 'Installation', link: '/guide/installation' });
for (const section of sections) {
  const title = /^## (.+)/.exec(section)[1].trim();
  const name = slug(title);
  await write(join(site, 'guide', `${name}.md`), page(section.replace(/^## /, '# '), 'packages/core'));
  guides.push({ text: title, link: `/guide/${name}` });
}

// One page per package, in the order of the root README's table, and the GitHub Action.
const order = [...root.matchAll(/\[`(@alimzen\/[^`]+)`\]\(packages\/([^)]+)\)/g)].map((m) => ({ npm: m[1], dir: m[2] }));
const known = new Set(order.map((p) => p.dir));
for (const dir of (await readdir(join(repo, 'packages'))).sort()) if (!known.has(dir)) order.push({ npm: dir, dir });
const packages = [];
for (const { npm, dir } of order) {
  const readme = join(repo, 'packages', dir, 'README.md');
  if (!existsSync(readme)) continue;
  await write(join(site, 'packages', `${dir}.md`), page(await readFile(readme, 'utf8'), `packages/${dir}`));
  packages.push({ text: npm.replace('@alimzen/', ''), link: `/packages/${dir}` });
}
const action = join(repo, 'actions', 'sim', 'README.md');
if (existsSync(action)) {
  await write(join(site, 'packages', 'action-sim.md'), page(await readFile(action, 'utf8'), 'actions/sim'));
  packages.push({ text: 'GitHub Action (Relayo Sim)', link: '/packages/action-sim' });
}

await write(join(site, '.vitepress', 'sidebar.json'), `${JSON.stringify({ guides, packages }, null, 2)}\n`);
console.log(`docs: ${guides.length + 1} guide pages, ${packages.length} package pages`);
