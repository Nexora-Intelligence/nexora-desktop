const { contextBridge, ipcRenderer } = require("electron");

/**
 * Nexora Desktop bridge — exposes permission-gated local capabilities to the
 * Nexora Chat / Nexora Code web UI. Every call round-trips to the main
 * process, which shows a native permission dialog before touching anything.
 * The web app advertises these as client tools to the runtime; the model's
 * client_tool_call requests are executed here and posted back.
 */
contextBridge.exposeInMainWorld("nexoraLocal", {
  exec: (command, cwd) => ipcRenderer.invoke("nexora:exec", { command, cwd }),
  readFile: (path) => ipcRenderer.invoke("nexora:readFile", { path }),
  writeFile: (path, content) => ipcRenderer.invoke("nexora:writeFile", { path, content }),
  listDir: (path) => ipcRenderer.invoke("nexora:listDir", { path }),
  remove: (path) => ipcRenderer.invoke("nexora:remove", { path }),
  info: () => ipcRenderer.invoke("nexora:info"),
  // Agent browser: one channel, many actions — navigate, read, click, type,
  // select, key, scroll, back, wait, screenshot, console, tabs, walkthrough.
  // Each returns the page as text, a numbered element map, and a screenshot.
  browser: (action, input) => ipcRenderer.invoke("nexora:browser", { action, input }),
  // Local workspace, the full action set (read, readMany, write, edit, list,
  // info, search, move, mkdir, delete, process, shell, policy) — one channel,
  // same implementation the MCP server uses. The five named methods above
  // remain for older console bundles.
  local: (action, input) => ipcRenderer.invoke("nexora:local", { action, input }),
  // Computer use: screenshot, action, batch, apps — drives the whole macOS
  // GUI, not just our own browser windows.
  computer: (action, input) => ipcRenderer.invoke("nexora:computer", { action, input }),
  // A native notification when long work finishes. Suppressed while the window
  // is focused, so it only ever reaches someone who walked away.
  notify: (payload) => ipcRenderer.invoke("nexora:notify", payload || {}),
  // Scheduled tasks that came due. The chat UI drains the queue when it mounts
  // and whenever the main process nudges it; taking is destructive, so a task
  // is handed out exactly once even if both happen at the same moment.
  takeTasks: () => ipcRenderer.invoke("nexora:takeTasks"),
  onTasks: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("nexora:tasks-waiting", handler);
    return () => ipcRenderer.removeListener("nexora:tasks-waiting", handler);
  },
});
