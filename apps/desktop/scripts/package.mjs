// Packages the Mac app: `pnpm package` builds locally, `pnpm release` also publishes to GitHub.
// Signing and notarisation credentials come from .env.local, which git ignores. See docs/release.md.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build } from 'electron-builder';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const publish = process.argv.includes('--publish');
const signed = Boolean(process.env.APPLE_API_KEY);

if (publish) {
  if (!signed)
    throw new Error('A release must be signed and notarised: set APPLE_API_KEY in .env.local.');
  // electron-builder uploads with this; the GitHub CLI's own login is enough.
  process.env.GH_TOKEN ??= execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}
if (!signed) {
  console.warn('No signing credentials: building an unsigned app, for this Mac only.');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

await build({
  publish: publish ? 'always' : 'never',
  config: signed ? undefined : { mac: { notarize: false } },
});
