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

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

if (publish) {
  if (!signed)
    throw new Error('A release must be signed and notarised: set APPLE_API_KEY in .env.local.');
  // electron-builder uploads with this; the GitHub CLI's own login is enough.
  process.env.GH_TOKEN ??= gh('auth', 'token');
  // The release is tagged at this commit, so it must already be on GitHub. CI builds a pushed
  // commit by definition.
  const commit = process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD');
  if (!process.env.GITHUB_ACTIONS && !git('branch', '-r', '--contains', commit))
    throw new Error('Push this commit first: the release is tagged at it.');
  let existing;
  try {
    existing = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft'));
  } catch {
    existing = undefined;
  }
  if (existing && !existing.isDraft)
    throw new Error(`${tag} is already published. Raise "version" in apps/desktop/package.json.`);
  // Made first, as a draft only you can see. electron-builder uploads every file into it at once;
  // left to create the release itself, its parallel uploads race each other and all but one fail.
  if (!existing)
    gh(
      'release',
      'create',
      tag,
      '--draft',
      '--target',
      commit,
      '--title',
      `Opsidian ${version}`,
      '--notes',
      `${git('log', '-1', '--format=%s', commit)}\n\n` +
        'Download Opsidian-arm64.dmg for Apple silicon, or Opsidian-x64.dmg for Intel.',
    );
}
if (!signed) {
  console.warn('No signing credentials: building an unsigned app, for this Mac only.');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

await build({
  publish: publish ? 'always' : 'never',
  config: signed ? undefined : { mac: { notarize: false } },
});

// Only now, with every file uploaded, does the release become public and the newest.
if (publish) {
  gh('release', 'edit', tag, '--draft=false', '--latest');
  console.log(`Published https://github.com/ferran9908/opsidian/releases/tag/${tag}`);
}
