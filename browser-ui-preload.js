const { contextBridge, ipcRenderer } = require("electron");

/**
 * Bridge for the browser window's own furniture — the chrome strip across the
 * top and the Nexora side panel. These are local pages shipped inside the app,
 * not web content, so they get a bridge; the page they sit around never does.
 *
 * Deliberately narrow: one request channel, two event channels, nothing that
 * takes a channel name from the caller.
 */
contextBridge.exposeInMainWorld("nexoraUI", {
  send: (message) => ipcRenderer.invoke("nexora:ui", message),
  onState: (handler) => ipcRenderer.on("nexora:ui:state", (_event, payload) => handler(payload)),
  onAnswer: (handler) => ipcRenderer.on("nexora:ui:answer", (_event, payload) => handler(payload)),
  onFind: (handler) => ipcRenderer.on("nexora:ui:find", (_event, payload) => handler(payload)),
  onCommand: (handler) => ipcRenderer.on("nexora:ui:command", (_event, payload) => handler(payload)),
});
