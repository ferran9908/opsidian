// Packages the Mac app: `pnpm package` builds locally, `pnpm release` also publishes to GitHub.
// Signing and notarisation credentials come from .env.local, which git ignores. See docs/release.md.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { build } from 'electron-builder';

const KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
// The file wins over the shell: a stale value exported in a terminal must not be used instead.
// (process.loadEnvFile would keep the shell's value.)
if (existsSync('.env.local'))
  for (const [name, value] of Object.entries(parseEnv(readFileSync('.env.local', 'utf8'))))
    process.env[name] = value;
const publish = process.argv.includes('--publish');
const signed = Boolean(process.env.APPLE_API_KEY);

if (signed) {
  const missing = KEYS.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(' and ')} in apps/desktop/.env.local.`);
  const key = process.env.APPLE_API_KEY.replace(/^~(?=\/)/, homedir());
  process.env.APPLE_API_KEY = key;
  // Checked now, rather than after minutes of building and signing.
  if (!existsSync(key))
    throw new Error(
      `APPLE_API_KEY points to ${key}, which does not exist.\n` +
        'Set it in apps/desktop/.env.local to the .p8 file in ~/.appstoreconnect/private_keys/.',
    );
  if (!key.endsWith(`AuthKey_${process.env.APPLE_API_KEY_ID}.p8`))
    console.warn(
      `Note: the key file's name does not match APPLE_API_KEY_ID (${process.env.APPLE_API_KEY_ID}).`,
    );
  console.log(`Signing and notarising with ${key}`);
}

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
