// electron-builder's afterSign hook: notarises the signed app, then staples Apple's ticket to it.
// electron-builder's own notarising gives up on the first stapling failure, and the stapler
// reaches Apple's ticket service over the network, which sometimes drops. Here stapling is tried
// again over a few minutes, and if it still cannot be done the release goes ahead: the app is
// notarised either way, and macOS asks Apple online when it is first opened.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: id, APPLE_API_ISSUER: issuer } = process.env;
  // Without credentials the app is unsigned and for this Mac only; nothing to notarise.
  if (!key || !id || !issuer) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const zip = `${app}.zip`;

  // notarytool takes a zip, and waits for Apple's answer.
  run('ditto', ['-c', '-k', '--keepParent', app, zip]);
  console.log(`  • notarising      ${app}`);
  const output = run('xcrun', [
    'notarytool',
    'submit',
    zip,
    '--key',
    key,
    '--key-id',
    id,
    '--issuer',
    issuer,
    '--wait',
    '--output-format',
    'json',
  ]);
  run('rm', ['-f', zip]);
  const result = JSON.parse(output);
  if (result.status !== 'Accepted')
    throw new Error(
      `Apple did not notarise the app (${result.status}). See: xcrun notarytool log ${result.id} --key … --key-id … --issuer …`,
    );
  console.log(`  • notarised       ${result.id}`);

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      run('xcrun', ['stapler', 'staple', app]);
      console.log('  • stapled');
      return;
    } catch (error) {
      const line = String(error.stdout || error.message)
        .trim()
        .split('\n')
        .at(-1);
      console.warn(`  • stapling failed (attempt ${attempt} of 6): ${line}`);
      if (attempt < 6) sleep(attempt * 15_000);
    }
  }
  console.warn(
    '::warning::The app is notarised but its ticket could not be stapled; macOS will check with Apple online when it is first opened.',
  );
};
