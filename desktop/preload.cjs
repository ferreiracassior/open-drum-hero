// Bridge between the app (Angular) and Windows. The app only sees window.drumhero.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drumhero', {
  version: process.env.npm_package_version || '1.0.0',
  songsterr: {
    fetch: (url, lang) => ipcRenderer.invoke('songsterr:fetch', url, lang),
    cancel: () => ipcRenderer.invoke('songsterr:cancel'),
    onProgress: cb => {
      const handler = (_e, msg) => cb(msg);
      ipcRenderer.on('songsterr:progress', handler);
      return () => ipcRenderer.removeListener('songsterr:progress', handler);
    },
  },
});
