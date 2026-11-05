import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Host } from '../apps/host/src/host';
import { Vault } from '../apps/desktop/electron/vault';
import {
  SyncEngine,
  httpTransport,
  pair,
  share,
  shares,
  unshare,
  type SyncState,
} from '../packages/sync/src/index';
import { SyncService } from '../packages/notebook/src/index';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'opsidian-share-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function startHost() {
  const host = new Host({ dataDir: await folder(), maxWait: 1 });
  const url = await host.listen(0, '127.0.0.1');
  cleanup.push(() => host.close());
  return { host, url };
}
type Server = Awaited<ReturnType<typeof startHost>>;

/** A device with a folder, synced by hand. */
async function device(server: Server) {
  const { code } = server.host.invite('Notes');
  const paired = await pair(server.url, code, 'Mac');
  const root = await folder();
  const vault = await Vault.open(root);
  cleanup.push(() => vault.close());
  const fresh: SyncState = {
    version: 1,
    host: server.url,
    notebook: paired.notebook.id,
    device: paired.device.id,
    deviceName: 'Mac',
    cursor: 0,
    files: {},
  };
  const engine = new SyncEngine(
    vault.syncStore(),
    httpTransport(server.url, paired.token),
    (await vault.syncState()) ?? structuredClone(fresh),
    () => {},
    { wait: 1 },
  );
  return {
    root,
    token: paired.token,
    notebook: paired.notebook.id,
    sync: () => engine.sync(),
    async write(path: string, content: string | Uint8Array) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
  };
}

describe('sharing a note', () => {
  it('refuses until sharing is turned on, and says how', async () => {
    const server = await startHost();
    const mac = await device(server);
    await mac.write('Plan.md', '# Plan\n');
    await mac.sync();
    await expect(share(server.url, mac.token, 'Plan.md', 24)).rejects.toThrow(
      /Sharing is not turned on/,
    );
    expect(await shares(server.url, mac.token)).toEqual([]);
  });

  it('serves the note as it was shared, with its images, to anyone with the link', async () => {
    const server = await startHost();
    server.host.setShareBase('https://mac.tail1234.ts.net/');
    const mac = await device(server);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await mac.write('attachments/photo.png', png);
    await mac.write('Private.md', 'Not shared.\n');
    await mac.write(
      'Trip/Plan.md',
      '---\ntags: [travel]\n---\n# Plan\n\nSee [[Private]] and ![[photo.png]].\n\n<script>alert(1)</script>\n',
    );
    await mac.sync();

    const made = await share(server.url, mac.token, 'Trip/Plan.md', 24);
    expect(made.url).toMatch(/^https:\/\/mac\.tail1234\.ts\.net\/s\/[A-Za-z0-9_-]{32}$/);
    expect(made.path).toBe('Trip/Plan.md');
    expect(made.expires).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const listed = await shares(server.url, mac.token);
    expect(listed.map((each) => each.id)).toEqual([made.id]);
    expect(listed[0]!.url).toBe(made.url);

    // A visitor has no credential, only the link.
    const path = new URL(made.url).pathname;
    const page = await fetch(server.url + path);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    const html = await page.text();
    expect(html).toContain('<title>Plan</title>');
    expect(html).toContain('<span class="tag">#travel</span>');
    expect(html).toContain('<span class="wiki">Private</span>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('stops working on');
    const image = /<img src="([^"]+)"/.exec(html)![1]!;
    expect(image).toMatch(new RegExp(`^${path}/[0-9a-f]{64}/photo\\.png$`));
    const file = await fetch(server.url + image);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);

    // A file the page does not show is not served, even by its real hash.
    const other = await fetch(`${server.url}${path}/${'0'.repeat(64)}/x.png`);
    expect(other.status).toBe(404);

    // The page is the note as shared: a later edit does not reach it.
    await mac.write('Trip/Plan.md', '# Plan\n\nChanged since.\n');
    await mac.sync();
    expect(await (await fetch(server.url + path)).text()).not.toContain('Changed since');

    // Tailscale may hand the path on with its mount point still on it.
    expect((await fetch(`${server.url}/s${path}`)).status).toBe(200);
  });

  it('stops working when stopped, when it runs out, and never for a guessed link', async () => {
    const server = await startHost();
    server.host.setShareBase('http://example.test');
    const mac = await device(server);
    await mac.write('Plan.md', '# Plan\n');
    await mac.sync();
    const forever = await share(server.url, mac.token, 'Plan.md', undefined);
    expect(forever.expires).toBeUndefined();
    const path = new URL(forever.url).pathname;
    expect(await (await fetch(server.url + path)).text()).toContain('works until it is stopped');

    const wrong = await fetch(`${server.url}/s/${'a'.repeat(32)}`);
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toContain('This link no longer works');

    await unshare(server.url, mac.token, forever.id);
    expect((await fetch(server.url + path)).status).toBe(404);
    expect(await shares(server.url, mac.token)).toEqual([]);
    await expect(unshare(server.url, mac.token, forever.id)).rejects.toThrow(/not shared/);

    // One that has run out is gone too, and no longer listed.
    const brief = await share(server.url, mac.token, 'Plan.md', 1 / 3600_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await fetch(server.url + new URL(brief.url).pathname)).status).toBe(404);
    expect(await shares(server.url, mac.token)).toEqual([]);

    // Only notes the host has can be shared, and only notes.
    await expect(share(server.url, mac.token, 'Nope.md', 1)).rejects.toThrow(/does not have/);
    await expect(share(server.url, mac.token, 'photo.png', 1)).rejects.toThrow(/Only notes/);
    await expect(share(server.url, mac.token, 'Plan.md', -1)).rejects.toThrow(/hour to a year/);
  });

  it('shares what the device has just written, through the sync service', async () => {
    const server = await startHost();
    server.host.setShareBase('http://example.test');
    const mac = await device(server);
    await mac.write('Plan.md', '# Plan\n');
    await mac.sync();
    const vault = await Vault.open(mac.root);
    cleanup.push(() => vault.close());
    const service = new SyncService(
      { get: async () => mac.token, set: async () => {} },
      () => 'Mac',
      () => {},
    );
    await service.attach(vault);
    cleanup.push(() => service.attach(null));
    await mac.write('Plan.md', '# Plan\n\nJust typed.\n');
    const made = await service.share('Plan.md', 2);
    const html = await (await fetch(server.url + new URL(made.url).pathname)).text();
    expect(html).toContain('Just typed.');
    expect((await service.shares()).map((each) => each.id)).toEqual([made.id]);
    await service.unshare(made.id);
    expect(await service.shares()).toEqual([]);
  });
});
