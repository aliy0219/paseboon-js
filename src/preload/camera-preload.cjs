// Sandboxed preload for the hidden camera window: exposes exactly two calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paseboonCamera', {
  /** Send one RGBA frame; resolves { more } (main decides when to stop). */
  frame: (width, height, data) => ipcRenderer.invoke('camera:frame', { width, height, data }),
  /** Report the end of the capture (error string or null). */
  done: (error) => ipcRenderer.send('camera:done', error ?? null),
});
