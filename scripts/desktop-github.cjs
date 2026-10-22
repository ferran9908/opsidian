// Runs inside Electron against the production app: signs in to GitHub, keeps a notebook in a
// repository, carries edits both ways, and imports a second notebook from a repository, all
// through the screens. GitHub is played by scripts/fake-github.cjs, which speaks real git.
const { app, BrowserWindow, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { fakeGitHub, USER } = require('./fake-github.cjs');

const { OPSIDIAN_VAULT_DIR: vault, OPSIDIAN_GITHUB_ROOT: root } = process.env;
app.setPath('userData', process.env.OPSIDIAN_PROFILE_DIR);
// Imported notebooks are made in Documents; a Mac finds it without looking at HOME.
app.setPath('documents', join(process.env.OPSIDIAN_PROFILE_DIR, '..', 'Documents'));
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, 'First.md'), 'written before GitHub\n');

const identity = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
const git = (cwd, ...args) =>
  execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, tries = 600) {
  let last;
  for (let n = 0; n < tries; n++) {
    try {
      if ((last = await check())) return last;
    } catch (error) {
      last = error;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`,
  );
}
let finished = false;
app.on('will-quit', () => {
  if (!finished) process.exit(1);
});

(async () => {
  // GitHub before the app, which reads where GitHub is when it loads.
  const github = fakeGitHub(root);
  const base = await github.start();
  process.env.OPSIDIAN_GITHUB_WEB = base;
  process.env.OPSIDIAN_GITHUB_API = base;
  const opened = [];
  shell.openExternal = async (url) => void opened.push(url);
  // A repository of notes made elsewhere, such as in Obsidian, to import later.
  const existing = github.create('notes');
  const seed = join(root, 'seed');
  git(root, 'clone', '--quiet', existing, seed);
  writeFileSync(join(seed, 'From GitHub.md'), '# Written on GitHub\n\nSee [[Ideas]].\n');
  mkdirSync(join(seed, 'Projects'));
  writeFileSync(join(seed, 'Projects', 'Ideas.md'), 'An idea\n');
  mkdirSync(join(seed, '.obsidian'));
  writeFileSync(join(seed, '.obsidian', 'app.json'), '{}\n');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '-m', 'Notes from Obsidian');
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');

  require('../apps/desktop/dist-electron/main.cjs');
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, 'window');
  const window = () => BrowserWindow.getAllWindows()[0];
  window().show();
  const evaluate = (script) =>
    window()
      .webContents.executeJavaScript(script)
      .catch((error) => {
        throw new Error(`${error.message}\n  in: ${script.slice(0, 300)}`);
      });
  const shows = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`);
  const click = (label) =>
    evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const button = (text) =>
    evaluate(
      `(() => { const all = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!all.length) throw new Error('No button ' + ${JSON.stringify(text)}); all[all.length - 1].click(); })()`,
    );
  // React keeps its own idea of an input's value; set it the way typing would.
  const type = (selector, value) =>
    evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const info = () => evaluate('window.opsidian.github()');
  const pass = (label) => console.log(`PASS ${label}`);
  // OPSIDIAN_SCREENSHOTS=folder keeps a picture of each screen, for looking at the design.
  const shot = async (name) => {
    const folder = process.env.OPSIDIAN_SCREENSHOTS;
    if (!folder) return;
    await delay(300);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${name}.png`), (await window().webContents.capturePage()).toPNG());
  };
  const tracked = (bare) =>
    git(root, '--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n');

  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[aria-label="Settings"]\'))'),
    'the notebook',
  );
  await click('Settings');
  await button('GitHub');
  await waitFor(() => shows('Keep your notebooks in a GitHub repository'), 'the GitHub settings');
  await shot('1-not-hosting');
  await button('Turn on hosting');
  await waitFor(() => shows('Keep on GitHub…'), 'hosting, and the notebook to keep');
  pass('GitHub settings offer hosting first, then the notebook');

  await button('Sign in with GitHub');
  await waitFor(() => shows('WDJB-MJHT'), 'the sign-in code');
  await shot('2-sign-in');
  assert.deepEqual(opened, [`${base}/login/device`]);
  await waitFor(() => shows(`Signed in as ${USER.login}`), 'signing in');
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="Sign in to GitHub"]\')'),
    null,
  );
  const profile = process.env.OPSIDIAN_PROFILE_DIR;
  // Readable only by this user; on a Mac the token in it is encrypted by the keychain too.
  assert.equal(statSync(join(profile, 'github.json')).mode & 0o777, 0o600);
  pass('signed in with a code, shown and opened in the browser');

  await button('Keep on GitHub…');
  await waitFor(() => shows(`${USER.login}/notes`), 'the list of repositories');
  await shot('3-choose-repository');
  // The suggested name is taken by an existing repository, so a new one is named.
  await type('[aria-label="New repository name"]', 'my-notes');
  await button('Keep on GitHub');
  await waitFor(() => shows('Up to date'), 'the first sync to GitHub');
  await shot('4-kept');
  const mine = join(root, USER.login, 'my-notes.git');
  assert.deepEqual(tracked(mine), ['First.md']);
  assert.equal(github.refusedGit > 0, true, 'git asked for the token, and was given it');
  pass('kept the notebook in a new private repository');

  // Typed in the app's folder: reaches GitHub by itself, after the pause that gathers typing.
  writeFileSync(join(vault, 'Typed.md'), 'typed on the Mac\n');
  await waitFor(() => tracked(mine).includes('Typed.md'), 'the note to reach GitHub', 1200);
  pass('a new note reached GitHub by itself');

  // An edit made on GitHub comes back.
  const clone = join(root, 'clone');
  git(root, 'clone', '--quiet', mine, clone);
  writeFileSync(join(clone, 'First.md'), 'edited on GitHub\n');
  git(clone, 'commit', '--quiet', '-am', 'Edit on GitHub');
  git(clone, 'push', '--quiet', 'origin', 'HEAD:main');
  await button('Sync now');
  await waitFor(
    () => readFileSync(join(vault, 'First.md'), 'utf8') === 'edited on GitHub\n',
    'the edit to arrive from GitHub',
  );
  pass('an edit made on GitHub arrived in the notebook');

  await button('Devices');
  await waitFor(() => shows(`Keeps “Notes” in ${USER.login}/my-notes`), 'the GitHub device');
  await shot('5-devices');
  pass('the device list says which device is GitHub');

  // Import: the repository becomes a notebook of its own, hosted here, in a new folder.
  await button('GitHub');
  await waitFor(() => shows('Import from GitHub'), 'the GitHub settings again');
  await button('Import…');
  await waitFor(() => shows('Make a notebook from a GitHub repository'), 'the import screen');
  // Already signed in, so the screen asks only for the repository.
  await waitFor(
    () => evaluate('Boolean(document.querySelector("#github-repository"))'),
    'the field',
  );
  await type('#github-repository', `${USER.login}/notes`);
  await shot('6-import');
  await button('Import and open');
  const imported = await waitFor(async () => {
    const current = await evaluate('window.opsidian.current()');
    return current && current.name !== 'Notes' ? current : undefined;
  }, 'the imported notebook to open');
  // “Notes” is taken, letter case aside, so the new notebook is numbered.
  assert.equal(imported.name, 'notes 2');
  await waitFor(() => existsSync(join(imported.location, 'Projects', 'Ideas.md')), 'the notes');
  assert.equal(
    readFileSync(join(imported.location, 'From GitHub.md'), 'utf8'),
    '# Written on GitHub\n\nSee [[Ideas]].\n',
  );
  assert.equal(existsSync(join(imported.location, '.obsidian')), false);
  const mirrors = (await info()).mirrors.map((each) => `${each.notebook} → ${each.repository}`);
  assert.deepEqual(mirrors.sort(), [
    `Notes → ${USER.login}/my-notes`,
    `notes 2 → ${USER.login}/notes`,
  ]);
  pass('imported a repository as a new notebook, hosted here and opened');

  // Writing in the imported notebook goes back to its repository, beside what was there.
  writeFileSync(join(imported.location, 'Projects', 'Ideas.md'), 'An idea, grown on the Mac\n');
  await waitFor(
    () =>
      git(root, '--git-dir', existing, 'show', 'main:Projects/Ideas.md') ===
      'An idea, grown on the Mac\n',
    'the imported notebook to send its edit',
    1200,
  );
  assert.ok(tracked(existing).includes('.obsidian/app.json'));
  pass('the imported notebook sends its edits back, leaving Obsidian’s settings alone');

  await click('Settings');
  await button('GitHub');
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-github="Notes"]\'))'),
    'notebooks',
  );
  await waitFor(
    () => evaluate('document.querySelectorAll("[data-github] .bg-success").length === 2'),
    'both in step',
  );
  await shot('7-two-notebooks');
  await evaluate(
    `[...document.querySelector('[data-github="Notes"]').querySelectorAll('button')].find((b) => b.textContent === 'Stop…').click()`,
  );
  await button('Stop');
  await waitFor(async () => (await info()).mirrors.length === 1, 'Notes to stop syncing to GitHub');
  assert.ok(tracked(mine).includes('Typed.md'));
  await button('Sign out');
  await waitFor(() => shows('Sign in with GitHub'), 'signing out');
  assert.equal(existsSync(join(profile, 'github.json')), false);
  pass('stopped one notebook and signed out; the repository kept everything');

  finished = true;
  github.close();
  app.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
