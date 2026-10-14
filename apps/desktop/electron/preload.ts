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
  move: call('note:move'),
  trash: call('note:trash'),
  trashed: call('trash:list'),
  restore: call('trash:restore'),
  emptyTrash: call('trash:empty'),
  saveImage: call('note:image-data'),
  backlinks: call('note:backlinks'),
  search: call('vault:search'),
  importImage: call('note:image'),
  imageUrl: (path: string) =>
    `opsidian://vault/${path.split('/').map(encodeURIComponent).join('/')}`,
  reveal: call('note:reveal'),
  onChange: subscribe('vault:changed'),
  syncInfo: call('sync:info'),
  connect: call('sync:connect'),
  disconnect: call('sync:disconnect'),
  confirmDeletions: call('sync:confirm-deletions'),
  joinVault: call('vault:join'),
  history: call('sync:history'),
  versionText: call('sync:version'),
  onSync: subscribe('sync:info'),
  checkConnection: call('sync:check'),
  openTailscale: call('sync:open-tailscale'),
  hosting: call('hosting:info'),
  startHosting: call('hosting:start'),
  stopHosting: call('hosting:stop'),
  setKeepRunning: call('hosting:keep-running'),
  invite: call('hosting:invite'),
  cancelInvitation: call('hosting:cancel-invitation'),
  removeDevice: call('hosting:remove-device'),
  backups: call('backup:info'),
  chooseBackupFolder: call('backup:choose-folder'),
  setBackupSchedule: call('backup:schedule'),
  backUpNow: call('backup:now'),
  restoreBackup: call('backup:restore'),
  onHosting: subscribe('hosting:info'),
  onCloseRequest: subscribe('window:flush'),
  closeFailed: call('window:close-failed'),
  closeReady: call('window:close-ready'),
});
