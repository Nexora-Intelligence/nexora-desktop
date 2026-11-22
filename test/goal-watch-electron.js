/**
 * The Electron half of the goal watcher (`attach` in goal-watch.js), run for
 * real: a real BrowserWindow with the shipped preload, a real Tray and Dock
 * badge, and the real page functions executed by Chromium — against a local
 * stand-in for the web app and its `/api/nx` proxy, never the live one.
 *
 * What it pins down that the plain-Node tests cannot: that the page read works
 * through executeJavaScript and brings back no key; that it is skipped off the
 * app's origin; that with the main window closed an unseen window takes over
 * (same stored sign-in, no bridge); and what a click does, for a web build that
 * knows the goal hand-over and for one that does not.
 *
 * Only `Notification` is a stand-in — a native notification cannot be read
 * back or clicked from a test.
 *
 * Run with `npm test` (needs a window server).
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const goalWatch = require("../goal-watch");

const PRELOAD = path.join(__dirname, "..", "preload.js");
const KEY = "nx_test_KEY-that-must-stay-in-the-page";
const A1 = "actor_3f9c1a2b4d5e6f70";

// Its own profile, so the stored sign-in is this test's and nobody else's. One
// fixed folder, emptied before each run: Chromium writes a few bytes back into
// it as it shuts down, so a fresh folder per run would leave one behind per run.
const profile = path.join(os.tmpdir(), "nexora-goal-watch-electron");
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);

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
async function until(probe, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > end) return value;
    await wait(100);
  }
}

/* ---- A stand-in for the web app ---------------------------------------------------- */

const seen = []; // { route, key } for each call to the proxy
const BUTTON = '<button aria-label="Goals — 1 needs your attention" onclick="window.__pressed = (window.__pressed || 0) + 1">Goals</button>';
const PAGES = {
  // A web build from before the hand-over: it has the Goals button and nothing else.
  old: `<!doctype html><title>chat</title>${BUTTON}`,
  // One that knows it: nudged, it takes the target.
  new: `<!doctype html><title>chat</title>${BUTTON}<script>
    window.__taken = [];
    const take = async () => { const target = await window.nexoraLocal.takeGoalTarget(); if (target) window.__taken.push(target); };
    window.nexoraLocal.onGoalTarget(take);
    take();
  </script>`,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/healthz") return json(200, { ok: true });
  if (url.pathname === "/chat") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGES[url.searchParams.get("web") || "old"]);
  }
  if (url.pathname.startsWith("/api/nx/")) {
    const route = url.pathname.slice("/api/nx".length);
    seen.push({ route, key: req.headers["x-api-key"] || "" });
    if (req.headers["x-api-key"] !== KEY) return json(401, { error: "unauthorized" });
    if (route === "/api/v1/notifications") {
      return json(200, {
        notifications: [
          {
            id: "ntf_3f9c1a2b4d5e6f70_7",
            kind: "actor.awaiting_input",
            title: "Actor is waiting for your answer",
            message: "EU or US first?",
            severity: "warning",
            read: false,
            createdAt: "2026-11-21T10:01:40.000Z",
            scope: "user",
            metadata: { actorId: A1, actorTitle: "Launch <b>plan</b>", conversationId: "chat_81d0c3f2a4b5e6f7", state: "awaiting_input", capabilities: [] },
          },
        ],
      });
    }
    if (route === "/api/v1/actors") return json(200, { actors: [{ id: A1, title: "Launch <b>plan</b>", intent: "Plan it", state: "awaiting_input" }] });
  }
  return json(404, { error: "not_found" });
});

/* ---- Stand-ins that let the test see what the host did ------------------------------ */

const notes = [];
class FakeNotification {
  static isSupported() {
    return true;
  }
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.shown = false;
    notes.push(this);
  }
  on(name, handler) {
    this.handlers[name] = handler;
  }
  show() {
    this.shown = true;
  }
}

let tray = null;
let trayIcon = null;
// A real Tray, kept where the test can read it back.
function SpyTray(icon) {
  trayIcon = icon;
  tray = new Tray(icon);
  return tray;
}
let trayItems = [];
const SpyMenu = {
  buildFromTemplate(template) {
    trayItems = template;
    return Menu.buildFromTemplate(template);
  },
};

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const appUrl = `${origin}/chat`;

  let win = null;
  const createWindow = () => {
    // Shaped like main.js's createWindow: the shipped preload, isolated.
    win = new BrowserWindow({ width: 700, height: 500, show: false, webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false } });
    win.on("closed", () => {
      win = null;
    });
    return win.loadURL(appUrl);
  };
  await createWindow();
  // loadURL resolves a beat before Chromium says the main frame has stopped
  // loading, and a page that is still loading is (rightly) not read.
  await until(() => !win.webContents.isLoadingMainFrame());
  const inPage = (js) => win.webContents.executeJavaScript(js, true);

  const goals = goalWatch.attach({
    electron: { app, BrowserWindow, Tray: SpyTray, Menu: SpyMenu, Notification: FakeNotification, nativeImage },
    getWindow: () => win,
    createWindow: () => void createWindow(),
    appUrl,
    homeOrigin: origin,
    userData: profile,
    onChange: () => undefined,
  });
  ipcMain.handle("nexora:takeGoalTarget", () => goals.takeTarget());

  goals.start();
  check("the menu bar item is made, from a template icon", Boolean(tray) && trayIcon.isTemplateImage() && !trayIcon.isEmpty());
  check("the icon is 18 points with a 2x representation", trayIcon.getSize().width === 18 && trayIcon.getScaleFactors().includes(2), JSON.stringify(trayIcon.getScaleFactors()));
  check("nothing is waiting yet: no title, no badge", tray.getTitle() === "" && app.dock.getBadge() === "");

  // --- Signed out: storage is read, the runtime is not asked.
  let result = await goals.tick();
  check("signed out: the read stops at the page's storage", result.outcome === "signed_out" && seen.length === 0, JSON.stringify(result));

  // --- Signed in (the way the web app stores it).
  await inPage(`localStorage.setItem("nexora.session", ${JSON.stringify(JSON.stringify({ state: { apiKey: KEY, principal: { id: "op-a" } }, version: 0 }))})`);
  const raw = await win.webContents.executeJavaScript(goalWatch.PAGE_READ_JS, false);
  check("the page read, run by Chromium, brings back rows and no key", raw.signedIn === true && raw.notifications.ok && raw.actors.ok && !JSON.stringify(raw).includes(KEY));
  check("it asked the page's own proxy, with the key in the header", seen.length === 2 && seen.every((call) => call.key === KEY), JSON.stringify(seen.map((call) => call.route)));

  result = await goals.tick();
  check("a new event: one notification, one goal needing you", result.outcome === "ok" && result.shown === 1 && result.needs === 1, JSON.stringify(result));
  check("the notification is this app's title and plain text", notes.length === 1 && notes[0].shown && notes[0].options.title === "A goal has a question for you" && notes[0].options.body === "Launch <b>plan</b>\nEU or US first?", JSON.stringify(notes[0] && notes[0].options));
  check("the Dock badge and the menu bar title show the count", app.dock.getBadge() === "1" && tray.getTitle() === "1", `${app.dock.getBadge()} / ${tray.getTitle()}`);
  const labels = trayItems.map((item) => item.label || item.type);
  check(
    "the menu lists the goal, then Open Goals, New Goal… and the switch",
    labels.join(" | ") === "1 goal needs you | Launch <b>plan</b> — has a question | separator | Open Goals | New Goal… | separator | Notify me about goals",
    labels.join(" | "),
  );
  check("the switch is a checked checkbox", trayItems.at(-1).type === "checkbox" && trayItems.at(-1).checked === true);
  const stored = JSON.parse(fs.readFileSync(path.join(profile, "goal-watch.json"), "utf8"));
  check("only the switch and the announced ids are stored — no key", JSON.stringify(Object.keys(stored)) === '["notify","announced"]' && stored.announced.length === 1 && !JSON.stringify(stored).includes(KEY));

  result = await goals.tick();
  check("the same event again: nothing", result.outcome === "ok" && result.shown === 0 && notes.length === 1);

  // --- A click, on a web build that does not know the hand-over: the Goals button is pressed.
  notes[0].handlers.click();
  const pressed = await until(() => inPage("window.__pressed || 0"));
  check("clicking the notification shows the window", win.isVisible());
  check("old web build: the page's Goals button is pressed, once", pressed === 1 && (await wait(1200), await inPage("window.__pressed")) === 1, String(pressed));
  check("the window stayed on the app's own address", win.webContents.getURL() === appUrl);

  // --- A click, on a web build that takes the target itself.
  await win.loadURL(`${appUrl}?web=new`);
  trayItems[1].click(); // the goal's row in the menu bar menu
  const taken = await until(() => inPage("window.__taken.length ? window.__taken : null"));
  await wait(1500);
  check("new web build: the page is handed the goal, by id", JSON.stringify(taken) === JSON.stringify([{ view: "goal", goalId: A1 }]), JSON.stringify(taken));
  check("…and the button is left alone", (await inPage("window.__pressed || 0")) === 0);
  goals.open({ view: "goal", goalId: 'actor_1"); alert(1); ("' });
  const second = await until(() => inPage("window.__taken.length > 1 ? window.__taken[1] : null"));
  check("an id of the wrong shape opens the list instead", JSON.stringify(second) === '{"view":"list"}', JSON.stringify(second));
  goals.open({ view: "new" });
  const third = await until(() => inPage("window.__taken.length > 2 ? window.__taken[2] : null"));
  check("New Goal… asks for the new-goal form", JSON.stringify(third) === '{"view":"new"}', JSON.stringify(third));
  await wait(1200);

  // --- Somewhere that is not the app: the read is skipped.
  let before = seen.length;
  await win.loadURL(`data:text/html,${encodeURIComponent("<p>somewhere else</p>")}`);
  result = await goals.tick();
  check("off the app's origin the read is skipped and nothing is asked", result.outcome === "skipped" && seen.length === before, JSON.stringify(result));
  check("…and the count it had is left as it was", app.dock.getBadge() === "1");

  // --- The main window closed: an unseen window takes over.
  win.destroy();
  await until(() => win === null);
  before = seen.length;
  result = await goals.tick();
  const hidden = BrowserWindow.getAllWindows();
  check("window closed: the first read opens an unseen window and waits for it", result.outcome === "skipped" && hidden.length === 1 && goals.ownsWindow(hidden[0]) && !hidden[0].isVisible(), JSON.stringify(result));
  await until(() => !hidden[0].webContents.isLoadingMainFrame() && hidden[0].webContents.getURL() === `${origin}/api/healthz`);
  check("it holds the health-check address, not the chat", hidden[0].webContents.getURL() === `${origin}/api/healthz`, hidden[0].webContents.getURL());
  check("it has no bridge to this Mac", (await hidden[0].webContents.executeJavaScript("typeof window.nexoraLocal")) === "undefined");
  result = await goals.tick();
  check("the next read goes through it, signed in as before", result.outcome === "ok" && seen.length === before + 2 && seen.slice(before).every((call) => call.key === KEY), JSON.stringify(result));
  check("it is the only window, so the Dock icon still reopens the app", BrowserWindow.getAllWindows().every((w) => goals.ownsWindow(w)));

  // --- Reopened from the menu bar: the main window comes back and the unseen one goes.
  trayItems.find((item) => item.label === "Open Goals").click();
  await until(() => win && !win.webContents.isLoadingMainFrame() && win.webContents.getURL() === appUrl);
  check("Open Goals with no window makes one, on the app's address", Boolean(win) && win.webContents.getURL() === appUrl);
  check("…and presses its Goals button once it has loaded", (await until(() => inPage("window.__pressed || 0"))) === 1);
  result = await goals.tick();
  check("the unseen window is gone once the main one is back", result.outcome === "ok" && BrowserWindow.getAllWindows().length === 1);

  // --- The switch.
  before = seen.length;
  trayItems.at(-1).click({ checked: false });
  check("switched off: no badge, no title, and the menu says so", app.dock.getBadge() === "" && tray.getTitle() === "" && trayItems[0].label === "Goal notifications are off" && trayItems.at(-1).checked === false);
  result = await goals.tick();
  check("switched off: nothing is read", result.outcome === "off" && seen.length === before);
  check("the switch is remembered", JSON.parse(fs.readFileSync(path.join(profile, "goal-watch.json"), "utf8")).notify === false);

  goals.stop();
  tray.destroy();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  app.exit(fail ? 1 : 0);
});

// The stored sign-in (a made-up key) goes when the run does.
process.on("exit", () => {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // The next run empties it.
  }
});

// The test closes its only window on purpose, and that must not end the run.
app.on("window-all-closed", () => undefined);
setTimeout(() => {
  console.log("FAIL — goal watch probe timed out");
  app.exit(1);
}, 90_000);
