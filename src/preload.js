'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', { name }),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', { id }),
  selectAccount: (id) => ipcRenderer.invoke('accounts:select', { id }),
  microsoftStart: () => ipcRenderer.invoke('accounts:microsoft-start'),
  microsoftCancel: (flowId) => ipcRenderer.invoke('accounts:microsoft-cancel', { flowId }),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', { text }),

  versions: (force = false) => ipcRenderer.invoke('versions:list', { force }),
  installVersion: (payload) => ipcRenderer.invoke('versions:install', payload),
  cancelInstall: (jobId) => ipcRenderer.invoke('install:cancel', { jobId }),
  deleteVersion: (versionId) => ipcRenderer.invoke('versions:delete', { versionId }),
  openFolder: (payload) => ipcRenderer.invoke('versions:open-folder', payload),
  fabricLoaders: (gameVersion) => ipcRenderer.invoke('fabric:loaders', { gameVersion }),
  loaderBuilds: (loader, gameVersion) =>
    ipcRenderer.invoke('loader:builds', { loader, gameVersion }),

  modsSearch: (payload) => ipcRenderer.invoke('mods:search', payload),
  modsInstall: (payload) => ipcRenderer.invoke('mods:install', payload),

  launch: (versionId) => ipcRenderer.invoke('game:launch', { versionId }),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  running: () => ipcRenderer.invoke('game:running'),
  getLogs: () => ipcRenderer.invoke('game:logs'),
  clearLogs: () => ipcRenderer.invoke('game:clear-logs'),

  getNews: (force = false) => ipcRenderer.invoke('news:get', { force }),

  detectJava: () => ipcRenderer.invoke('system:detect-java'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('system:pick-folder', { defaultPath }),
  pickJava: (defaultPath) => ipcRenderer.invoke('system:pick-java', { defaultPath }),
  openPath: (target) => ipcRenderer.invoke('system:open-path', { target }),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', { url }),

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    state: () => ipcRenderer.invoke('window:state'),
    onMaximized: subscribe('window:maximized'),
  },

  onInstallProgress: subscribe('install:progress'),
  onInstallDone: subscribe('install:done'),
  onInstallError: subscribe('install:error'),
  onLaunchStatus: subscribe('launch:status'),
  onGameStarted: subscribe('game:started'),
  onGameExit: subscribe('game:exit'),
  onGameLog: subscribe('game:log'),
  onMicrosoftStatus: subscribe('microsoft:status'),
  onMicrosoftDone: subscribe('microsoft:done'),
  onMicrosoftError: subscribe('microsoft:error'),
});
