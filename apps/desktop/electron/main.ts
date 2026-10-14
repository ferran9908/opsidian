import { app, BrowserWindow, ipcMain, dialog, protocol, net, session, Menu, shell } from 'electron';
import { lstat, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateContent, validateName, type VaultInfo } from '@opsidian/core';
import { themes } from '@opsidian/theme';
import { Vault } from './vault';
import { desktopSync, hostAddress } from './sync';

protocol.registerSchemesAsPrivileged([
  { scheme: 'opsidian', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!app.requestSingleInstanceLock()) app.quit();
else void start();

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid request.');
  return value;
}

async function start() {
  await app.whenReady();
  app.setName('Opsidian');
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  const defaultParent = join(app.getPath('documents'), 'Opsidian');
  let window: BrowserWindow | null = null;
  let mayClose = false;
  let vault: Vault | null = null;

  const sync = desktopSync(app.getPath('userData'), (info) =>
    window?.webContents.send('sync:info', info),
  );
  async function use(directory: string, remember: boolean): Promise<VaultInfo> {
    const next = await Vault.open(directory);
    vault?.close();
    vault = next;
    next.watch((paths) => window?.webContents.send('vault:changed', paths));
    await sync.attach(next);
    if (remember) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ vault: next.root }));
    }
    return { name: next.name, location: next.root };
  }
  const open = (): Vault => {
    if (!vault) throw new Error('Open a notebook first.');
    return vault;
  };
  // A vault named by the environment is for development and tests; it is never remembered.
  const forced = process.env.OPSIDIAN_VAULT_DIR;
  const remembered = forced
    ? undefined
    : await readFile(settingsPath, 'utf8')
        .then((raw) => JSON.parse(raw).vault as unknown)
        .catch(() => undefined);
  const initial = forced ?? (typeof remembered === 'string' ? remembered : undefined);
  // A remembered vault that has since moved or been deleted leads back to the welcome screen.
  if (initial) await use(initial, false).catch(() => undefined);

  const rendererRoot = resolve(__dirname, '../dist');
  protocol.handle('opsidian', async (request) => {
    const url = new URL(request.url);
    if (url.host === 'vault') {
      try {
        const file = await open().image(decodeURIComponent(url.pathname.slice(1)));
        return await net.fetch(pathToFileURL(file).href);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const path = resolve(
      rendererRoot,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    );
    if (!path.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(path).href);
  });
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) =>
    callback(false),
  );
  // macOS refuses Documents, Desktop and Downloads to an app that was never granted them.
  const denied = (reason: unknown) => {
    const { code, path } = reason as NodeJS.ErrnoException;
    if (code !== 'EPERM' && code !== 'EACCES') return undefined;
    return new Error(
      `macOS is not letting Opsidian use ${path ? `“${path}”` : 'that folder'}. ` +
        'Allow it in System Settings → Privacy & Security → Files and Folders, or choose another folder.',
    );
  };
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted request');
      try {
        return await handler(...args);
      } catch (reason) {
        throw denied(reason) ?? reason;
      }
    });

  handle('vault:current', () => (vault ? { name: vault.name, location: vault.root } : null));
  handle('vault:default-parent', () => defaultParent);
  handle('vault:choose-parent', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Where should the notebook live?',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle('vault:create', async (name, parent) => {
    validateName(name);
    const directory = join(parent === undefined ? defaultParent : text(parent, 4000), name);
    const existing = await readdir(directory).catch((reason) => {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw reason;
    });
    if (existing.some((entry) => !entry.startsWith('.')))
      throw new Error(`“${name}” already exists there and is not empty. Open it instead.`);
    return use(directory, true);
  });
  handle('vault:open', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Open a folder of Markdown notes',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return use(result.filePaths[0], true);
  });
  handle('vault:tree', () => open().tree());
  handle('note:read', (path) => open().read(text(path)));
  handle('note:save', (path, content, revision) => {
    validateContent(content);
    return open().save(text(path), content, text(revision, 64));
  });
  handle('note:create', (folder, name) =>
    open().createNote(text(folder), name === undefined ? undefined : text(name, 200)),
  );
  handle('folder:create', (parent, name) => open().createFolder(text(parent), text(name, 200)));
  handle('note:rename', (path, name) => open().rename(text(path), text(name, 200)));
  handle('note:move', (path, folder) => open().move(text(path), text(folder)));
  handle('note:trash', (path) => open().trash(text(path)));
  handle('trash:list', () => open().trashed());
  handle('trash:restore', (name) => open().restore(text(name, 300)));
  handle('trash:empty', async () => {
    const result = await dialog.showMessageBox(window!, {
      type: 'warning',
      message: 'Empty this notebook’s trash?',
      detail: 'Everything in it moves to the Mac’s Trash, where it can still be recovered.',
      buttons: ['Cancel', 'Empty trash'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return false;
    await open().emptyTrash((file) => shell.trashItem(file));
    return true;
  });
  handle('note:image-data', (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid request.');
    return open().saveImage(bytes);
  });
  handle('note:backlinks', (path) => open().backlinks(text(path)));
  handle('vault:search', (query) => open().search(text(query, 200)));
  handle('note:reveal', async (path) => shell.showItemInFolder(await open().file(text(path))));
  handle('note:image', async () => {
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return open().importImage(result.filePaths[0]);
  });
  handle('sync:info', () => sync.info());
  handle('sync:connect', async (host, code) => {
    const address = hostAddress(text(host, 500));
    await sync.adopt(open(), address, await sync.invite(address, text(code, 100)));
    return sync.info();
  });
  handle('sync:disconnect', () => sync.disconnect());
  handle('sync:confirm-deletions', () => sync.confirmDeletions());
  handle('sync:history', (path) => sync.history(text(path)));
  handle('sync:version', (hash) => sync.versionText(text(hash, 64)));
  handle('vault:join', async (host, code, parent) => {
    const address = hostAddress(text(host, 500));
    const root = parent === undefined ? defaultParent : text(parent, 4000);
    // Check the folder before spending the invitation, which works only once.
    await mkdir(root, { recursive: true });
    const pairing = await sync.invite(address, text(code, 100));
    // The invitation is spent, so nothing from here on may fail for a reason that a
    // different folder name would have avoided.
    let name = pairing.notebook.name;
    try {
      validateName(name);
    } catch {
      name = 'Notebook';
    }
    const free = async (directory: string) =>
      lstat(directory).then(
        async (found) => found.isDirectory() && !(await readdir(directory)).length,
        () => true,
      );
    let directory = join(root, name);
    for (let count = 1; !(await free(directory)); count++)
      directory = join(root, `${name} ${count}`);
    const info = await use(directory, true);
    await sync.adopt(open(), address, pairing);
    return info;
  });
  handle('window:close-failed', async (message) => {
    const result = await dialog.showMessageBox(window!, {
      type: 'warning',
      message: 'Your latest changes could not be saved.',
      detail:
        typeof message === 'string'
          ? message.slice(0, 2000)
          : 'Return to the note and retry saving.',
      buttons: ['Keep editing', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) {
      mayClose = true;
      window?.close();
    }
  });
  handle('window:close-ready', () => {
    mayClose = true;
    window?.close();
  });
  const createWindow = () => {
    mayClose = false;
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 740,
      minHeight: 550,
      title: 'Opsidian',
      backgroundColor: themes.dark.background,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', () => {
      mayClose = true;
    });
    window.webContents.on('did-fail-load', () => {
      mayClose = true;
    });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (!mayClose && !window?.webContents.isLoadingMainFrame()) {
        event.preventDefault();
        window?.webContents.send('window:flush');
      }
    });
    window.on('closed', () => {
      window = null;
    });
    const devUrl = process.env.OPSIDIAN_RENDERER_URL;
    if (devUrl) {
      const url = new URL(devUrl);
      if (url.hostname !== '127.0.0.1') throw new Error('Development renderer must be on loopback');
      void window.loadURL(devUrl);
    } else void window.loadURL('opsidian://app/');
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Opsidian', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  createWindow();
  app.on('activate', () => {
    if (!window) createWindow();
  });
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
}
