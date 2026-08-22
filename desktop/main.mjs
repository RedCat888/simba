import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, session } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GATEWAY = process.env.SIMBA_GATEWAY ?? 'http://127.0.0.1:8787';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMain();
    }
  });
}

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let quitting = false;

function icon() {
  return nativeImage.createFromPath(join(here, 'icon.png'));
}

async function api(path, opts = {}) {
  const r = await fetch(`${GATEWAY}${path}`, {
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error((data && (data.error || data.message)) || text || `${r.status}`);
  return data;
}

function createMain() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    title: 'Simba',
    icon: icon(),
    backgroundColor: '#081018',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(join(here, 'dist', 'index.html'));
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    width: 64,
    height: 64,
    x: workArea.x + workArea.width - 88,
    y: workArea.y + 280,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(join(here, 'ui', 'overlay.html'));
}

function createTray() {
  tray = new Tray(icon());
  tray.setToolTip('Simba');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Simba', click: () => createMain() },
      { label: 'Toggle overlay', click: () => overlayWindow?.webContents.send('overlay-toggle') },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => createMain());
}

function fanout(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('live', msg);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('live', msg);
}

function connectLive() {
  const url = GATEWAY.replace(/^http/, 'ws') + '/ws';
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error('[simba-desktop] live socket failed', err);
    setTimeout(connectLive, 2500);
    return;
  }
  socket.addEventListener('message', (ev) => {
    try {
      fanout(JSON.parse(String(ev.data)));
    } catch {
      /* ignore malformed frames */
    }
  });
  socket.addEventListener('close', () => setTimeout(connectLive, 2500));
  socket.addEventListener('error', () => socket.close());
}

function bindIpc() {
  ipcMain.handle('today', () => api('/api/today'));
  ipcMain.handle('home', () => api('/api/simba'));
  ipcMain.handle('say', (_e, text) =>
    api('/api/simba/say', { method: 'POST', body: JSON.stringify({ text }) }),
  );
  ipcMain.handle('messages', (_e, id) => api(`/api/sessions/${id}/messages`));
  ipcMain.handle('capture', (_e, text) =>
    api('/api/capture', { method: 'POST', body: JSON.stringify({ content: text, source: 'desktop-overlay' }) }),
  );
  ipcMain.handle('pending', () => api('/api/actions/pending'));
  ipcMain.handle('confirm', (_e, id, approve) =>
    api(`/api/actions/${id}/confirm`, { method: 'POST', body: JSON.stringify({ approve }) }),
  );
  ipcMain.handle('missions', () => api('/api/missions'));
  ipcMain.handle('start-mission', (_e, title, objective) =>
    api('/api/missions', { method: 'POST', body: JSON.stringify({ title, objective }) }),
  );
  ipcMain.handle('intakes', () => api('/api/intakes'));
  ipcMain.handle('poll-intakes', () => api('/api/intakes/poll', { method: 'POST', body: '{}' }));
  ipcMain.handle('stats', () => api('/api/stats'));
  ipcMain.handle('voice-status', () => api('/api/voice'));
  ipcMain.handle('voice-ask', async (_e, buf, ext) => {
    const body = Buffer.from(buf);
    const r = await fetch(`${GATEWAY}/api/voice/ask?ext=${encodeURIComponent(ext || 'webm')}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  });
  ipcMain.handle('voice-speak', async (_e, text) => {
    const r = await fetch(`${GATEWAY}/api/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(await r.text());
    const ab = await r.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  });
  ipcMain.on('overlay-move', (_e, dx, dy) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const b = overlayWindow.getBounds();
    overlayWindow.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
  });
  ipcMain.on('open-main', () => createMain());
  let overlayAnchor = null;
  ipcMain.on('overlay-size', (_e, expanded) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const b = overlayWindow.getBounds();
    if (expanded) {
      overlayAnchor = { x: b.x, y: b.y };
      overlayWindow.setBounds({ x: Math.max(8, b.x - 284), y: b.y, width: 348, height: 520 });
    } else {
      overlayWindow.setBounds({
        x: overlayAnchor?.x ?? b.x,
        y: overlayAnchor?.y ?? b.y,
        width: 64,
        height: 64,
      });
    }
  });
}

if (gotLock) {
  app.whenReady().then(() => {
    app.setName('Simba');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'microphone');
    });
    bindIpc();
    connectLive();
    createMain();
    createOverlay();
    createTray();
    globalShortcut.register('Control+Shift+Space', () => {
      overlayWindow?.webContents.send('overlay-toggle');
    });
    globalShortcut.register('Control+Shift+T', () => {
      overlayWindow?.webContents.send('ptt', true);
    });
  }).catch((err) => {
    console.error('[simba-desktop] failed to start', err);
  });
}

app.on('window-all-closed', () => {
  // Stay in the tray. Overlay and hotkeys keep running.
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
