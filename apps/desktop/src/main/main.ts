import path from 'node:path';
import { app, BrowserWindow, session, shell, systemPreferences } from 'electron';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const API_URL = process.env.PEN_API_URL ?? 'https://api.penplayground.com';

/** Native microphone permission on macOS must be requested before getUserMedia can succeed. */
async function ensureMicrophone(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  return systemPreferences.askForMediaAccess('microphone');
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Pen Playground',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1013',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'fullscreen');
  });
  await ensureMicrophone();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export { API_URL };
