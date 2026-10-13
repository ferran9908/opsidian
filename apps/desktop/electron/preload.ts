import { contextBridge, ipcRenderer } from 'electron';

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);
const subscribe = (channel: string) => (callback: (...args: unknown[]) => void) => {
  const listener = (_event: unknown, ...args: unknown[]) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('opsidian', {
  current: call('vault:current'),
  defaultParent: call('vault:default-parent'),
  chooseParent: call('vault:choose-parent'),
  createVault: call('vault:create'),
  openVault: call('vault:open'),
  tree: call('vault:tree'),
  read: call('note:read'),
  save: call('note:save'),
  createNote: call('note:create'),
  createFolder: call('folder:create'),
  rename: call('note:rename'),
  trash: call('note:trash'),
  backlinks: call('note:backlinks'),
  search: call('vault:search'),
  importImage: call('note:image'),
  imageUrl: (path: string) =>
    `opsidian://vault/${path.split('/').map(encodeURIComponent).join('/')}`,
  reveal: call('note:reveal'),
  onChange: subscribe('vault:changed'),
  onCloseRequest: subscribe('window:flush'),
  closeFailed: call('window:close-failed'),
  closeReady: call('window:close-ready'),
});
