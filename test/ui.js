/**
 * Drives the real browser chrome and Ask panel — the shipped HTML and the
 * shipped preload — against a stub main process, and checks what they send.
 *
 * Run with `npm test` (needs a window server: these views only behave when the
 * window is actually on screen).
 */
const { app, BrowserWindow, WebContentsView, ipcMain } = require("electron");
const path = require("node:path");

const DESKTOP = path.join(__dirname, "..");
const PRELOAD = path.join(DESKTOP, "browser-ui-preload.js");

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sent = [];
ipcMain.handle("nexora:ui", (_event, message) => {
  sent.push(message);
  return { ok: true };
});
const lastSent = () => sent.at(-1);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: true });
  const mk = (file) => {
    const view = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 300 });
    return view.webContents.loadFile(path.join(DESKTOP, file)).then(() => view.webContents);
  };

  // ---- the chrome strip -------------------------------------------------
  const chrome = await mk("browser-chrome.html");
  const js = (code) => chrome.executeJavaScript(code, true);
  check("the chrome bridge is exposed", (await js("typeof window.nexoraUI.send")) === "function");

  chrome.send("nexora:ui:state", { url: "https://example.com/a", canGoBack: true, canGoForward: false, findOpen: true });
  await wait(150);
  check("state fills the address bar", (await js("document.getElementById('url').value")) === "https://example.com/a");
  check("Back lights when there is history", (await js("document.getElementById('back').disabled")) === false);
  check("Forward stays dark without any", (await js("document.getElementById('forward').disabled")) === true);
  check("the find row opens on state", (await js("document.getElementById('findrow').classList.contains('open')")) === true);

  // Typing must open a NEW search; Enter and the arrows must step the running one.
  await js(`(() => { const f = document.getElementById('findtext'); f.value = 'beta';
    f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(120);
  check("typing asks for a fresh search", lastSent()?.action === "find" && lastSent()?.fresh === true, JSON.stringify(lastSent()));

  await js(`document.getElementById('findtext').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(120);
  check("Enter steps the running search", lastSent()?.fresh === false && lastSent()?.forward === true, JSON.stringify(lastSent()));

  await js(`document.getElementById('findtext').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))`);
  await wait(120);
  check("Shift+Enter steps backwards", lastSent()?.fresh === false && lastSent()?.forward === false, JSON.stringify(lastSent()));

  await js("document.getElementById('findprev').click()");
  await wait(120);
  check("the up arrow steps backwards", lastSent()?.forward === false && lastSent()?.fresh === false, JSON.stringify(lastSent()));

  chrome.send("nexora:ui:find", { matches: 3, active: 2 });
  await wait(120);
  check("the match count reads back", (await js("document.getElementById('findcount').textContent")) === "2 of 3");
  chrome.send("nexora:ui:find", { matches: 0, active: 0 });
  await wait(120);
  check("a miss says so, in red", (await js("document.getElementById('findcount').textContent")) === "no matches");
  check("the miss is marked", (await js("document.getElementById('findcount').classList.contains('none')")) === true);

  chrome.send("nexora:ui:command", { name: "focusFind" });
  await wait(150);
  check("⌘F lands the caret in the find box", (await js("document.activeElement.id")) === "findtext");
  chrome.send("nexora:ui:command", { name: "focusAddress" });
  await wait(150);
  check("⌘L lands the caret in the address bar", (await js("document.activeElement.id")) === "url");

  await js("document.getElementById('findclose').click()");
  await wait(120);
  check("the close button asks to close find", lastSent()?.action === "findClose", JSON.stringify(lastSent()));

  // Loading turns Reload into Stop and starts the sweep.
  chrome.send("nexora:ui:state", { url: "https://example.com/a", loading: true, findOpen: false });
  await wait(150);
  check("Reload becomes Stop while loading", (await js("document.getElementById('reload').textContent")) === "✕");
  check("the sweep bar runs while loading", (await js("document.getElementById('bar').classList.contains('on')")) === true);
  check("closing find clears what was typed", (await js("document.getElementById('findtext').value")) === "");
  await js("document.getElementById('reload').click()");
  await wait(120);
  check("the button stops the load, not reloads it", lastSent()?.action === "stop", JSON.stringify(lastSent()));

  chrome.send("nexora:ui:state", { url: "https://example.com/a", loading: false });
  await wait(150);
  check("Stop turns back into Reload", (await js("document.getElementById('reload').textContent")) === "↻");
  await js("document.getElementById('reload').click()");
  await wait(120);
  check("and reloads once the page has settled", lastSent()?.action === "reload", JSON.stringify(lastSent()));

  // The address bar must not fight the user while they are typing in it. The
  // view has to be focused first: Chromium holds back the focus event in a
  // document that hasn't got focus, and that event is what marks it as edited.
  chrome.focus();
  await wait(150);
  await js(`(() => { const u = document.getElementById('url'); u.focus(); u.value = 'nexora.dev'; })()`);
  chrome.send("nexora:ui:state", { url: "https://example.com/b" });
  await wait(150);
  check("typing an address survives a state push", (await js("document.getElementById('url').value")) === "nexora.dev");
  await js(`document.getElementById('url').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(120);
  check("Enter navigates to what was typed", lastSent()?.action === "navigate" && lastSent()?.url === "nexora.dev", JSON.stringify(lastSent()));

  await js("document.getElementById('ask').click()");
  await wait(120);
  check("Ask Nexora toggles the panel", lastSent()?.action === "toggleSidebar", JSON.stringify(lastSent()));

  // ---- the Ask panel ----------------------------------------------------
  const panel = await mk("browser-sidebar.html");
  const pjs = (code) => panel.executeJavaScript(code, true);

  panel.send("nexora:ui:command", { name: "ask", question: "Explain the text I have selected, in plain language." });
  await wait(200);
  check("the right-click ask reaches the panel", lastSent()?.action === "ask", JSON.stringify(lastSent()));
  check(
    "and it draws the question in the thread",
    (await pjs("document.querySelectorAll('#log .turn').length")) === 2,
    await pjs("document.getElementById('log').textContent"),
  );

  panel.send("nexora:ui:answer", { type: "delta", text: "It is " });
  panel.send("nexora:ui:answer", { type: "delta", text: "a paragraph." });
  await wait(200);
  check(
    "deltas stream into the answer",
    (await pjs("document.querySelector('#log .turn:last-child .body').textContent")) === "It is a paragraph.",
  );
  panel.send("nexora:ui:answer", { type: "done" });
  await wait(150);
  check("done re-enables asking", (await pjs("document.getElementById('send').disabled")) === false);

  await pjs(`(() => { const i = document.getElementById('input'); i.value = 'book the cheapest flight';
    document.getElementById('doit').click(); })()`);
  await wait(150);
  check(
    "Have Nexora do it hands the goal over",
    lastSent()?.action === "handoff" && lastSent()?.goal === "book the cheapest flight",
    JSON.stringify(lastSent()),
  );
  check("and clears the box behind it", (await pjs("document.getElementById('input').value")) === "");

  await pjs("document.getElementById('open').click()");
  await wait(120);
  check("Continue in Nexora Chat opens the thread", lastSent()?.action === "openChat", JSON.stringify(lastSent()));

  panel.send("nexora:ui:state", { url: "https://news.example.org/story" });
  await wait(150);
  check("the panel names the host it is reading", (await pjs("document.getElementById('page').textContent")) === "news.example.org");

  // ---- the screen-share picker -------------------------------------------
  // The fallback for every Mac without the macOS 15 system picker, which is
  // most of them. Its own preload, its own two channels.
  const PIXEL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const SOURCES = [
    { id: "screen:0:0", name: "Entire Screen", kind: "screen", thumbnail: PIXEL },
    { id: "window:12:0", name: "Nexora Chat", kind: "window", thumbnail: PIXEL },
    { id: "window:19:0", name: "Terminal", kind: "window", thumbnail: PIXEL },
  ];
  let picked = "nothing yet";
  ipcMain.handle("nexora:share-sources", () => SOURCES);
  ipcMain.on("nexora:share-pick", (_event, id) => {
    picked = id;
  });

  const pickerView = new WebContentsView({
    webPreferences: { preload: path.join(DESKTOP, "share-preload.js"), contextIsolation: true, sandbox: false },
  });
  win.contentView.addChildView(pickerView);
  pickerView.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  const picker = pickerView.webContents;
  await picker.loadFile(path.join(DESKTOP, "share-picker.html"));
  const sjs = (code) => picker.executeJavaScript(code, true);
  await wait(250);

  check("the picker bridge is exposed", (await sjs("typeof window.nexoraShare.pick")) === "function");
  check("every source gets a tile", (await sjs("document.querySelectorAll('.tile').length")) === 3);
  check(
    "screens and windows are told apart",
    (await sjs("[...document.querySelectorAll('h2')].map((h) => h.textContent).join('/')")) === "Screens/Windows",
  );
  check("Share stays dark until something is chosen", (await sjs("document.getElementById('share').disabled")) === true);

  await sjs("document.querySelectorAll('.tile')[1].click()");
  await wait(120);
  check("choosing a tile marks it", (await sjs("document.querySelectorAll('.tile')[1].getAttribute('aria-selected')")) === "true");
  check("and lights Share", (await sjs("document.getElementById('share').disabled")) === false);
  await sjs("document.getElementById('share').click()");
  await wait(120);
  check("Share sends the id the picker was given", picked === "window:12:0", String(picked));

  picked = "nothing yet";
  await sjs("document.querySelectorAll('.tile')[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await wait(120);
  check("double-click shares straight away", picked === "window:19:0", String(picked));

  picked = "nothing yet";
  await sjs("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await wait(120);
  check("Escape cancels rather than sharing", picked === null, String(picked));

  console.log(`\n${pass}/${pass + fail} checks passed`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});

app.on("window-all-closed", () => undefined);
setTimeout(() => {
  console.log("FAIL — probe timed out");
  app.exit(1);
}, 90_000);
