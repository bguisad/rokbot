// Preload for the "Migrate from Grok Bot" window. Only these calls cross into the main process.
const { contextBridge, ipcRenderer } = require('electron');
const call = (name, ...args) => ipcRenderer.invoke(`rokbot-migrate:${name}`, ...args);
contextBridge.exposeInMainWorld('rokMigrate', {
  detect: () => call('detect'),
  uploadFolder: folder => call('upload-folder', folder),
  chooseFolder: () => call('choose-folder'),
  chooseFile: () => call('choose-file'),
  list: () => call('list'),
  createToken: body => call('create-token', body),
  revokeToken: id => call('revoke-token', id),
  prompt: options => call('prompt', options),
  preview: id => call('preview', id),
  import: (id, selection) => call('import', id, selection),
  discard: id => call('discard', id),
  copy: text => call('copy', text),
  onProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('rokbot-migrate:progress', listener);
    return () => ipcRenderer.removeListener('rokbot-migrate:progress', listener);
  },
});
