import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  nativeImage,
  net,
  session,
  Menu,
  shell,
  Tray,
} from 'electron';
import { Hosting } from './hosting';
import { lstat, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateContent,
  validateName,
  type GitHubSchedule,
  type RepositoryChoice,
  type VaultInfo,
} from '@opsidian/core';
import { themes } from '@opsidian/theme';
import { Vault } from './vault';
import { desktopSync, hostAddress } from './sync';
import { Updates } from './updates';

protocol.registerSchemesAsPrivileged([
  { scheme: 'opsidian', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!app.requestSingleInstanceLock()) app.quit();
else void start();

/** Icons drawn from design/logo by `pnpm icons`. */
const resources = join(__dirname, '../resources');

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid request.');
  return value;
}

async function start() {
  await app.whenReady();
  app.setName('Opsidian');
  // An installed app takes its icon from the bundle; a development run has to be told.
  if (!app.isPackaged) app.dock?.setIcon(join(resources, 'icon.png'));
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  const defaultParent = join(app.getPath('documents'), 'Opsidian');
  let window: BrowserWindow | null = null;
  let mayClose = false;
  /**
   * Set by Cmd+Q, the menu bar icon's Quit, or an update restart. The window holds its close
   * until the open note is saved, and holding it cancels the quit, so the quit is finished once
   * the window has gone.
   */
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  let vault: Vault | null = null;

  const sync = desktopSync(app.getPath('userData'), (info) =>
    window?.webContents.send('sync:info', info),
  );
  let tray: Tray | undefined;
  /** Opens the window, if it is closed, and has it check for a new version where you can see. */
  const checkForUpdates = () => {
    if (!window) createWindow();
    window?.show();
    const ask = () => window?.webContents.send('updates:check-requested');
    if (window?.webContents.isLoading()) window.webContents.once('did-finish-load', ask);
    else ask();
  };
  /** What the menus offer about updates follows the one update state. */
  const updateItems = (): Electron.MenuItemConstructorOptions[] => {
    const update = updates.state;
    if (update.kind === 'ready')
      return [{ label: `Restart to Update to ${update.version}`, click: () => updates.restart() }];
    if (update.kind === 'available')
      return [{ label: `Download Opsidian ${update.version}`, click: () => updates.download() }];
    if (update.kind === 'downloading')
      return [
        { label: `Downloading ${update.version}… ${Math.round(update.percent)}%`, enabled: false },
      ];
    return [];
  };
  const menus = () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Opsidian',
          submenu: [
            { role: 'about' },
            ...(updates.available
              ? [...updateItems(), { label: 'Check for Updates…', click: checkForUpdates }]
              : []),
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Hosting notebooks for your devices', enabled: false },
        { type: 'separator' },
        ...updateItems(),
        { label: 'Open Opsidian', click: () => app.emit('activate') },
        { label: 'Quit Opsidian', role: 'quit' },
      ]),
    );
  };
  let shownPercent = -1;
  const updates = new Updates((state) => {
    window?.webContents.send('updates:state', state);
    // Menus are rebuilt for every change of state, but only every tenth of a download.
    if (state.kind === 'downloading') {
      const step = Math.floor(state.percent / 10);
      if (step === shownPercent) return;
      shownPercent = step;
    } else shownPercent = -1;
    menus();
  });
  /** While this Mac hosts for other devices, it stays in the menu bar with no window open. */
  const showTray = () => {
    const wanted = hosting.keepRunning;
    if (wanted && !tray) {
      // A template image: macOS draws it in the menu bar's own colour, light or dark.
      tray = new Tray(nativeImage.createFromPath(join(resources, 'trayTemplate.png')));
      tray.setToolTip('Opsidian is hosting your notebooks');
      menus();
    } else if (!wanted && tray) {
      tray.destroy();
      tray = undefined;
    }
    // Only an installed app can sensibly start itself at login.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: wanted });
  };
  const hosting: Hosting = new Hosting(app.getPath('userData'), sync, (info) => {
    window?.webContents.send('hosting:info', info);
    showTray();
  });
  // Whatever goes wrong with hosting, the notebook itself must still open.
  await hosting.load().catch(() => {});
  showTray();
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
  handle('vault:graph', () => open().graph());
  // The empty path is the notebook itself, opened as a Finder window.
  handle('note:reveal', async (path) => {
    if (text(path) === '') return void (await shell.openPath(open().root));
    shell.showItemInFolder(await open().file(text(path)));
  });
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
  handle('sync:check', () => sync.check('this Mac', async () => net.isOnline()));
  handle('sync:open-tailscale', async () => {
    await shell.openPath('/Applications/Tailscale.app');
  });
  handle('hosting:info', () => hosting.info());
  handle('hosting:start', () => hosting.start(open()));
  handle('hosting:stop', () => hosting.stop());
  handle('hosting:keep-running', (value) => hosting.setKeepRunning(value === true));
  handle('hosting:invite', (notebook) => hosting.invite(text(notebook, 200)));
  handle('hosting:cancel-invitation', (id) => hosting.cancelInvitation(text(id, 100)));
  handle('hosting:remove-device', (id) => hosting.removeDevice(text(id, 100)));
  handle('github:info', () => hosting.github());
  handle('github:sign-in', () => hosting.signInToGitHub());
  handle('github:finish-sign-in', () => hosting.finishGitHubSignIn());
  handle('github:cancel-sign-in', () => hosting.cancelGitHubSignIn());
  handle('github:sign-out', () => hosting.signOutOfGitHub());
  handle('github:repositories', () => hosting.githubRepositories());
  const choice = (value: unknown): RepositoryChoice => {
    const given = value as { repository?: unknown; create?: unknown } | null;
    if (typeof given?.create === 'string') return { create: text(given.create, 100) };
    return { repository: text(given?.repository, 500) };
  };
  handle('github:keep', (notebook, chosen) =>
    hosting.keepOnGitHub(text(notebook, 200), choice(chosen)),
  );
  handle('github:import', async (chosen, parent) => {
    const { address, code } = await hosting.importFromGitHub(choice(chosen));
    const root = parent === undefined ? defaultParent : text(parent, 4000);
    const { info, pairing } = await joinNotebook(address, code, root);
    await hosting.adopt(info.location, pairing.notebook.name, pairing.device.id);
    return info;
  });
  handle('github:sync', (notebook, confirm) =>
    hosting.syncGitHub(text(notebook, 200), confirm === true),
  );
  handle('github:schedule', (every) =>
    hosting.setGitHubSchedule(text(every, 10) as GitHubSchedule),
  );
  handle('github:stop', (notebook) => hosting.stopGitHub(text(notebook, 200)));
  handle('backup:info', () => hosting.backups());
  handle('backup:choose-folder', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Where should backups be saved?',
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = result.canceled ? undefined : result.filePaths[0];
    return folder ? hosting.setBackup({ folder }) : null;
  });
  handle('backup:schedule', (hour, keep) =>
    hosting.setBackup({
      hour: typeof hour === 'number' && hour >= 0 && hour < 24 ? Math.floor(hour) : null,
      keep: typeof keep === 'number' && keep >= 1 && keep <= 365 ? Math.floor(keep) : 14,
    }),
  );
  handle('backup:now', () => hosting.backUpNow());
  handle('backup:restore', (name) => hosting.restore(text(name, 100)));
  /** Makes a folder for a notebook that lives on a host, and downloads it there. */
  async function joinNotebook(address: string, code: string, parent: string) {
    // Check the folder before spending the invitation, which works only once.
    await mkdir(parent, { recursive: true });
    const pairing = await sync.invite(address, code);
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
    let directory = join(parent, name);
    for (let count = 1; !(await free(directory)); count++)
      directory = join(parent, `${name} ${count}`);
    const info = await use(directory, true);
    await sync.adopt(open(), address, pairing);
    return { info, pairing };
  }
  handle('vault:join', async (host, code, parent) => {
    const address = hostAddress(text(host, 500));
    const root = parent === undefined ? defaultParent : text(parent, 4000);
    return (await joinNotebook(address, text(code, 100), root)).info;
  });
  /**
   * How many parts of the page have work to save before the window may close: the editor, while
   * it is open. Nothing else is waited for, so every other screen closes, and quits, at once.
   */
  let guards = 0;
  /** While the page saves, a limit on the wait: a page that has stopped could not save anyway. */
  let flushing: NodeJS.Timeout | undefined;
  const settled = () => {
    clearTimeout(flushing);
    flushing = undefined;
  };
  handle('updates:state', () => updates.state);
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:restart', () => updates.restart());
  handle('app:version', () => app.getVersion());
  handle('app:help', () => shell.openExternal('https://github.com/ferran9908/opsidian#readme'));
  handle('edit:clipboard', (action) => {
    if (action === 'cut') window?.webContents.cut();
    else if (action === 'copy') window?.webContents.copy();
    else if (action === 'paste') window?.webContents.paste();
  });
  ipcMain.on('window:guard', (event, on: unknown) => {
    if (event.sender !== window?.webContents) return;
    guards = Math.max(0, guards + (on === true ? 1 : -1));
  });
  handle('window:close-failed', async (message) => {
    settled();
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
    } else quitting = false;
  });
  handle('window:close-ready', () => {
    settled();
    mayClose = true;
    window?.close();
  });
  const createWindow = () => {
    mayClose = false;
    guards = 0;
    settled();
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
    // A reload starts the page afresh; whatever guarded the old one is gone.
    window.webContents.on('did-start-loading', () => {
      guards = 0;
    });
    window.on('close', (event) => {
      if (mayClose || guards === 0 || window?.webContents.isLoadingMainFrame()) return;
      event.preventDefault();
      if (flushing) return;
      flushing = setTimeout(() => {
        flushing = undefined;
        mayClose = true;
        // Destroyed, not closed: a page that has stopped answering would not answer that either.
        window?.destroy();
      }, 10_000);
      window?.webContents.send('window:flush');
    });
    window.on('closed', () => {
      window = null;
      settled();
    });
    const devUrl = process.env.OPSIDIAN_RENDERER_URL;
    if (devUrl) {
      const url = new URL(devUrl);
      if (url.hostname !== '127.0.0.1') throw new Error('Development renderer must be on loopback');
      void window.loadURL(devUrl);
    } else void window.loadURL('opsidian://app/');
  };
  menus();
  createWindow();
  app.on('activate', () => {
    if (!window) createWindow();
  });
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  // Hosting keeps the app alive in the menu bar when its window is closed; asking to quit, or
  // closing the window when not hosting, quits.
  app.on('window-all-closed', () => {
    if (quitting || !hosting.keepRunning) app.quit();
  });
  let closing = false;
  // Only once quitting is certain: every window has agreed to close by now, so a quit the
  // user cancels to keep editing leaves hosting running.
  app.on('will-quit', (event) => {
    if (closing) return;
    // The host's database is closed properly before the process goes.
    event.preventDefault();
    closing = true;
    void hosting.close().finally(() => app.exit(0));
  });
}
