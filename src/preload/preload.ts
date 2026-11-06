import { contextBridge, ipcRenderer } from 'electron';

const call = (channel: string) => (...args: any[]) => ipcRenderer.invoke(channel, ...args);

const channels = [
  'claudeDir', 'homeDir', 'encodeProjectDir', 'listProjects', 'loadSession', 'getRecord', 'saveSession', 'checkSave',
  'forkSession', 'listBackups', 'restoreBackup', 'previewReplace', 'applyReplace', 'getApiRequest',
  'readMemory', 'writeMemory', 'exportBundle', 'pickBundle', 'importBundle', 'revealInExplorer', 'copyText',
];

const api: Record<string, any> = {};
for (const c of channels) api[c] = call(c);
api.onLoadProgress = (cb: (p: any) => void) => {
  const listener = (_e: unknown, p: any) => cb(p);
  ipcRenderer.on('loadProgress', listener);
  return () => ipcRenderer.removeListener('loadProgress', listener);
};

contextBridge.exposeInMainWorld('api', api);
