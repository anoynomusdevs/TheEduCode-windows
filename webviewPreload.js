const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
  configRequest: () => ipcRenderer.send('configRequest'),
  runCode: (payload) => ipcRenderer.invoke('run-code', payload)
});


