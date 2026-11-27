require('./workspace-keys.cjs');
require('./suggestions-composer.cjs');
require('../dist/electron-preload/preload.cjs');
const { ipcRenderer, contextBridge } = require('electron');
contextBridge.exposeInMainWorld('localBot', {
  locale: ipcRenderer.sendSync('rokbot-local:locale'),
  openManagement: () => ipcRenderer.send('rokbot-local:open-management'),
  updateProfile: (id, profile) => ipcRenderer.invoke('rokbot-local:update-profile', { id, profile }),
  connectionStatus: () => ipcRenderer.invoke('rokbot-local:status'),
  mintVoiceCredential: agentId => ipcRenderer.invoke('rokbot-local:voice-credential', agentId),
  getVoicePreference: () => ipcRenderer.invoke('rokbot-local:voice-preference'),
  setVoicePreference: enabled => ipcRenderer.invoke('rokbot-local:voice-preference', enabled),
  onVoicePreferenceChanged: callback => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('rokbot-local:voice-preference', listener);
    return () => ipcRenderer.removeListener('rokbot-local:voice-preference', listener);
  },
  pair: args => ipcRenderer.invoke('rokbot-local:pair', args),
  disconnect: () => ipcRenderer.invoke('rokbot-local:disconnect'),
  getLocalStatus: () => ipcRenderer.invoke('rokbot-local:local-status'),
  getModelConfig: () => ipcRenderer.invoke('rokbot-local:model-get'),
  getUsage: payload => ipcRenderer.invoke('rokbot-local:usage', payload),
  updateModelConfig: payload => ipcRenderer.invoke('rokbot-local:model-put', payload),
  fetchModelCatalog: payload => ipcRenderer.invoke('rokbot-local:model-catalog', payload),
  testModelConfig: payload => ipcRenderer.invoke('rokbot-local:model-test', payload),
  getSuggestionsSettings: () => ipcRenderer.invoke('rokbot-local:suggestions-settings-get'),
  updateSuggestionsSettings: payload => ipcRenderer.invoke('rokbot-local:suggestions-settings-put', payload),
  addQuickPhrase: text => ipcRenderer.invoke('rokbot-local:suggestions-phrase-add', { text }),
  updateQuickPhrase: (id, text) => ipcRenderer.invoke('rokbot-local:suggestions-phrase-update', { id, text }),
  deleteQuickPhrase: id => ipcRenderer.invoke('rokbot-local:suggestions-phrase-delete', { id }),
  reorderQuickPhrases: ids => ipcRenderer.invoke('rokbot-local:suggestions-phrase-reorder', { ids }),
  downloadAttachmentsZip: payload => ipcRenderer.invoke('rokbot-local:download-attachments-zip', payload),
  onConnectionChanged: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('rokbot-local:connection-changed', listener);
    return () => ipcRenderer.removeListener('rokbot-local:connection-changed', listener);
  },
});
