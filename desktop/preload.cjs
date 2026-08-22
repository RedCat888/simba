const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('simba', {
  today: () => ipcRenderer.invoke('today'),
  home: () => ipcRenderer.invoke('home'),
  say: (text) => ipcRenderer.invoke('say', text),
  messages: (id) => ipcRenderer.invoke('messages', id),
  capture: (text) => ipcRenderer.invoke('capture', text),
  pending: () => ipcRenderer.invoke('pending'),
  confirm: (id, approve) => ipcRenderer.invoke('confirm', id, approve),
  missions: () => ipcRenderer.invoke('missions'),
  startMission: (title, objective) => ipcRenderer.invoke('start-mission', title, objective),
  intakes: () => ipcRenderer.invoke('intakes'),
  pollIntakes: () => ipcRenderer.invoke('poll-intakes'),
  stats: () => ipcRenderer.invoke('stats'),
  voiceAsk: (buf, ext) => ipcRenderer.invoke('voice-ask', buf, ext),
  voiceSpeak: (text) => ipcRenderer.invoke('voice-speak', text),
  voiceStatus: () => ipcRenderer.invoke('voice-status'),
  openMain: () => ipcRenderer.send('open-main'),
  overlaySize: (expanded) => ipcRenderer.send('overlay-size', expanded),
  moveOverlay: (dx, dy) => ipcRenderer.send('overlay-move', dx, dy),
  onOverlayToggle: (fn) => ipcRenderer.on('overlay-toggle', fn),
  onPtt: (fn) => ipcRenderer.on('ptt', (_e, down) => fn(down)),
  onLive: (fn) => {
    const handler = (_e, msg) => fn(msg);
    ipcRenderer.on('live', handler);
    return () => ipcRenderer.removeListener('live', handler);
  },
});
