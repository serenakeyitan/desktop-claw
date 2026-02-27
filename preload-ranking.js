const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rankingAPI', {
  getRanking: (period) => ipcRenderer.invoke('get-ranking', period)
});
