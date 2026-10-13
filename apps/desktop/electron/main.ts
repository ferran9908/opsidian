import { app, BrowserWindow, ipcMain, dialog, protocol, net, session, Menu } from 'electron';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrototypeStore } from './storage';
import { validateContent } from '@opsidian/core';
import { themes } from '@opsidian/theme';

protocol.registerSchemesAsPrivileged([
  { scheme: 'opsidian', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start() {
  await app.whenReady();
  app.setName('Opsidian');
  const root =
    process.env.OPSIDIAN_VAULT_DIR ?? join(app.getPath('documents'), 'Opsidian Prototype');
  const store = new PrototypeStore(root);
  const rendererRoot = resolve(__dirname, '../dist');
  protocol.handle('opsidian', (request) => {
    const url = new URL(request.url);
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
  let window: BrowserWindow | null = null;
  let mayClose = false;
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('Untrusted request');
  };
  ipcMain.handle('note:load', (event) => {
    trusted(event);
    return store.load();
  });
  ipcMain.handle('note:save', (event, content: unknown) => {
    trusted(event);
    validateContent(content);
    return store.save(content);
  });
  ipcMain.handle('note:image', async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return store.importImage(result.filePaths[0]);
  });
  ipcMain.handle('window:close-failed', async (event, message: unknown) => {
    trusted(event);
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
  ipcMain.handle('window:close-ready', (event) => {
    trusted(event);
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
      trafficLightPosition: { x: 24, y: 24 },
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
