import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('opsidian', {
  load: () => ipcRenderer.invoke('note:load'),
  save: (content: string) => ipcRenderer.invoke('note:save', content),
  importImage: () => ipcRenderer.invoke('note:image'),
  onCloseRequest: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('window:flush', listener);
    return () => ipcRenderer.removeListener('window:flush', listener);
  },
  closeFailed: (message: string) => ipcRenderer.invoke('window:close-failed', message),
  closeReady: () => ipcRenderer.invoke('window:close-ready'),
});
