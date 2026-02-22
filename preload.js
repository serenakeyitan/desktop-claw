const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Config management
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openConfig: () => ipcRenderer.invoke('open-config'),

  // Window management
  setWindowPosition: (position) => ipcRenderer.invoke('set-window-position', position),
  showContextMenu: () => ipcRenderer.invoke('show-context-menu'),

  // App control
  quitApp: () => ipcRenderer.invoke('quit-app'),
  setEnvApiKey: (apiKey) => ipcRenderer.invoke('set-env-api-key', apiKey),

  // Setup flow
  checkClaudeInstalled: () => ipcRenderer.invoke('check-claude-installed'),
  checkClaudeCredentials: () => ipcRenderer.invoke('check-claude-credentials'),
  testClaudeConnection: () => ipcRenderer.invoke('test-claude-connection'),
  completeSetup: (authType) => ipcRenderer.invoke('complete-setup', authType),

  // Event listeners
  onTokenUpdate: (callback) => {
    ipcRenderer.on('token-update', (event, data) => callback(data));
  },

  onStateChange: (callback) => {
    ipcRenderer.on('state-change', (event, data) => callback(data));
  },

  onResetTick: (callback) => {
    ipcRenderer.on('reset-tick', (event, data) => callback(data));
  },

  // Remove listeners
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('token-update');
    ipcRenderer.removeAllListeners('state-change');
    ipcRenderer.removeAllListeners('reset-tick');
  }
});