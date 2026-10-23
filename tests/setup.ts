import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Runs before every test file. A machine that runs these tests may also host real notebooks in
 * `~/.opsidian`; whatever a test does with the host's own paths lands in a folder made for it.
 */
const home = mkdtempSync(join(tmpdir(), 'opsidian-home-'));
process.env.OPSIDIAN_HOME = home;
// Not a development build, whatever ran the tests.
delete process.env.npm_lifecycle_event;
afterAll(() => rmSync(home, { recursive: true, force: true }));
