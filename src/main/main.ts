import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { claudeDir, encodeProjectDir } from './paths';
import { listProjects } from './scanner';
import {
  loadSession, getRecord, saveSession, checkSave, forkSession, listBackups, restoreBackup,
  previewReplace, applyReplace, getApiRequest,
} from './session';
import { readMemory, writeMemory } from './memory';
import { exportBundle, readBundleManifest, importBundle } from './transfer';
import type { ExportRequest, ImportRequest } from '../shared/types';

let win: BrowserWindow | null = null;

if (process.env.CHM_DRIVE) {
  // UI checks run while other windows cover this one; keep rendering anyway.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#141413',
    title: 'Claude History Manager',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141413', symbolColor: '#c9c5bb', height: 38 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !process.env.CHM_DRIVE,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Fallback in case ready-to-show never fires (seen with some GPU drivers).
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 1500);
    if (process.env.CHM_DRIVE) runDriveScript(process.env.CHM_DRIVE);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/** Dev-only: run a JSON list of {js?, wait?, shot?} steps against the window (used for UI checks). */
async function runDriveScript(file: string) {
  const fs = await import('node:fs');
  const steps: { js?: string; wait?: number; shot?: string; quit?: boolean; keys?: string[]; text?: string }[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const st of steps) {
    if (!win) return;
    if (st.wait) await new Promise((r) => setTimeout(r, st.wait));
    if (st.js) {
      try { const r = await win.webContents.executeJavaScript(st.js, true); if (r !== undefined) console.log('[drive]', JSON.stringify(r)); } catch (e) { console.log('[drive] error', String(e)); }
    }
    for (const k of st.keys || []) {
      const [mod, key] = k.includes('+') ? k.split('+') : [undefined, k];
      const modifiers = mod ? [mod as 'control'] : [];
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
      await new Promise((r) => setTimeout(r, 50));
    }
    if (st.text) { await win.webContents.insertText(st.text); await new Promise((r) => setTimeout(r, 200)); }
    if (st.shot) fs.writeFileSync(st.shot, (await win.webContents.capturePage()).toPNG());
    if (st.quit) app.quit();
  }
}

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args));
}

app.whenReady().then(() => {
  handle('claudeDir', () => claudeDir());
  handle('homeDir', () => os.homedir());
  handle('encodeProjectDir', (cwd: string) => encodeProjectDir(cwd));
  handle('listProjects', () => listProjects());
  handle('loadSession', (file: string) =>
    loadSession(file, (fraction) => win?.webContents.send('loadProgress', { file, fraction })));
  handle('getRecord', getRecord);
  handle('saveSession', saveSession);
  handle('checkSave', checkSave);
  handle('forkSession', forkSession);
  handle('listBackups', listBackups);
  handle('restoreBackup', restoreBackup);
  handle('previewReplace', previewReplace);
  handle('applyReplace', applyReplace);
  handle('getApiRequest', getApiRequest);
  handle('readMemory', readMemory);
  handle('writeMemory', writeMemory);
  handle('revealInExplorer', (p: string) => shell.showItemInFolder(p));
  handle('copyText', (t: string) => clipboard.writeText(t));
  handle('exportBundle', async (req: ExportRequest) => {
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export conversations',
      defaultPath: `${req.projectDir}-${new Date().toISOString().slice(0, 10)}.claudebundle.zip`,
      filters: [{ name: 'Claude history bundle', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try { return exportBundle(req, res.filePath); } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
  });
  handle('pickBundle', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import conversations',
      properties: ['openFile'],
      filters: [{ name: 'Claude history bundle', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return { path: res.filePaths[0], manifest: readBundleManifest(res.filePaths[0]) };
  });
  handle('importBundle', async (req: ImportRequest) => {
    try { return await importBundle(req); } catch (err: any) { return { ok: false, error: String(err?.message || err), imported: [], memoryWritten: [], skipped: [] }; }
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
