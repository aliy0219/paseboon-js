// Sandboxed preload for the settings window: a small, explicit API, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('paseboon', {
  getState: () => ipcRenderer.invoke('get-state'),
  authUnlock: () => ipcRenderer.invoke('auth-unlock'),
  authTouch: () => ipcRenderer.invoke('auth-touch'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  enroll: (add) => ipcRenderer.invoke('enroll', { add: Boolean(add) }),
  testCamera: () => ipcRenderer.invoke('test-camera'),
  testLock: () => ipcRenderer.invoke('test-lock'),
  setLoginItem: (enabled) => ipcRenderer.invoke('set-login-item', Boolean(enabled)),
  setPaused: (paused) => ipcRenderer.invoke('set-paused', Boolean(paused)),
  usbState: () => ipcRenderer.invoke('usb-state'),
  usbTrustConnected: () => ipcRenderer.invoke('usb-trust-connected'),
  usbTrust: (key) => ipcRenderer.invoke('usb-trust', String(key)),
  usbUntrust: (key) => ipcRenderer.invoke('usb-untrust', String(key)),
  usbClearEvents: () => ipcRenderer.invoke('usb-clear-events'),
  photosDeleteAll: () => ipcRenderer.invoke('photos-delete-all'),
  photosOpenFolder: () => ipcRenderer.invoke('photos-open-folder'),
  onState: listen('state'),
  onEnrollProgress: listen('enroll-progress'),
});
