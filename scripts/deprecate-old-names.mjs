// Marks the packages published before the rename as deprecated, pointing to their new names.
// Run once, after `pnpm release` has published the @alimzen/relayo* packages:
//   node scripts/deprecate-old-names.mjs
// Needs `npm login` with publish rights on the alimzen org; npm asks for 2FA when needed.
import { spawnSync } from 'node:child_process';

const RENAMES = {
  '@alimzen/core': '@alimzen/relayo',
  '@alimzen/smtp': '@alimzen/relayo-smtp',
  '@alimzen/ses': '@alimzen/relayo-ses',
  '@alimzen/sendgrid': '@alimzen/relayo-sendgrid',
  '@alimzen/resend': '@alimzen/relayo-resend',
  '@alimzen/postmark': '@alimzen/relayo-postmark',
  '@alimzen/mailgun': '@alimzen/relayo-mailgun',
  '@alimzen/simulator': '@alimzen/relayo-simulator',
  '@alimzen/bounces': '@alimzen/relayo-bounces',
  '@alimzen/imap': '@alimzen/relayo-imap',
  '@alimzen/nestjs': '@alimzen/relayo-nestjs',
  '@alimzen/cli': '@alimzen/relayo-cli',
};

// npm is npm.cmd on Windows; a shell resolves it on every platform.
const npm = (args, inherit = false) =>
  spawnSync('npm', args, { shell: true, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });

let failed = 0;
for (const [oldName, newName] of Object.entries(RENAMES)) {
  // Never point people at a package that does not exist yet.
  const published = npm(['view', newName, 'version']);
  if (published.status !== 0 || !published.stdout.trim()) {
    console.error(`✗ ${oldName}: ${newName} is not on npm yet. Run "pnpm release" first.`);
    failed++;
    continue;
  }
  const result = npm(['deprecate', oldName, `"Renamed to ${newName}: install ${newName} instead (same code)."`], true);
  if (result.status === 0) console.log(`✓ ${oldName} → ${newName}`);
  else {
    console.error(`✗ ${oldName}: npm deprecate failed`);
    failed++;
  }
}

console.log(failed ? `\n${failed} package(s) not deprecated; fix and run again (it is safe to repeat).` : '\nDone: the old names show a deprecation notice on install.');
process.exitCode = failed ? 1 : 0;
