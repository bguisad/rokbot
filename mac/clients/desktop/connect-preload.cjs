const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', {
  locale: ipcRenderer.sendSync('rokbot-local:locale'),
  status: () => ipcRenderer.invoke('rokbot-local:status'),
  pair: (server, key, tailcat, edit = false, mode = 'code') => ipcRenderer.invoke('rokbot-local:pair', { server, key, tailcat, edit, mode }),
  disconnect: () => ipcRenderer.invoke('rokbot-local:disconnect'),
});
