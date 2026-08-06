const { contextBridge, ipcRenderer } = require("electron");

/**
 * The screen-share picker's whole vocabulary: ask what can be shared, say which
 * one. `share-picker.html` is local, has no network access and gets no other
 * channel — closing the window is the same as cancelling.
 */
contextBridge.exposeInMainWorld("nexoraShare", {
  sources: () => ipcRenderer.invoke("nexora:share-sources"),
  pick: (id) => ipcRenderer.send("nexora:share-pick", id),
  cancel: () => ipcRenderer.send("nexora:share-pick", null),
});
