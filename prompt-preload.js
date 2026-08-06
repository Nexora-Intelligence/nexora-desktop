const { contextBridge, ipcRenderer } = require("electron");

/**
 * The one thing a modal form needs to say: here is what the user typed, or
 * nothing. `schedule-prompt.html` is local, has no network access and gets no
 * other channel — closing the window is the same as cancelling.
 */
contextBridge.exposeInMainWorld("nexoraPrompt", {
  submit: (value) => ipcRenderer.send("nexora:prompt-done", value),
  cancel: () => ipcRenderer.send("nexora:prompt-done", null),
});
