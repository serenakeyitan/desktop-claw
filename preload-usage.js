const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usageAPI', {
  save: (percentage) => ipcRenderer.invoke('save-manual-usage', percentage),
  close: () => ipcRenderer.invoke('close-usage-window')
});
