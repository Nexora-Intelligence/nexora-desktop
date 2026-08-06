/**
 * Pins the Electron behaviour the Nexora browser window is built on, in a
 * window shaped like createTab()'s: three WebContentsViews in one BrowserWindow.
 *
 * These are assumptions, not our code — which is the point. An Electron upgrade
 * that changes find-in-page semantics or makes capturePage window-relative
 * would break the browser quietly, and this is where it would show up first.
 */
const { app, BrowserWindow, WebContentsView, Menu, session } = require("electron");
const path = require("node:path");

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

/** Collect every event of a kind for a while — found-in-page arrives in
 *  instalments, and only the last one is the whole truth. */
function collect(emitter, event, ms) {
  const seen = [];
  const handler = (...args) => seen.push(args[1] ?? args[0]);
  emitter.on(event, handler);
  return wait(ms).then(() => {
    emitter.removeListener(event, handler);
    return seen;
  });
}

const PAGE = path.join(__dirname, "fixtures", "page.html");
const OTHER = `data:text/html,${encodeURIComponent("<p>somewhere else</p>")}`;

app.whenReady().then(async () => {
  // Shown on purpose: Chromium skips find-in-page and capturePage work for an
  // invisible window, which is exactly what the real browser windows are not.
  const win = new BrowserWindow({ width: 900, height: 600, show: true });
  const page = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: "persist:probe" },
  });
  const chrome = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  const sidebar = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(page);
  win.contentView.addChildView(chrome);
  win.contentView.addChildView(sidebar);
  const wc = page.webContents;

  const relayout = (findOpen) => {
    const { width, height } = win.getContentBounds();
    const top = findOpen ? 40 + 34 : 40;
    chrome.setBounds({ x: 0, y: 0, width, height: top });
    page.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    sidebar.setBounds({ x: width, y: top, width: 0, height: Math.max(0, height - top) });
  };
  relayout(false);
  check("three views mount in one window", win.contentView.children.length === 3);

  await Promise.all([wc.loadFile(PAGE), chrome.webContents.loadURL("about:blank"), sidebar.webContents.loadURL("about:blank")]);
  check("the page loads", wc.getURL().endsWith("page.html"));

  const nav = wc.navigationHistory;
  check("navigationHistory answers canGoBack", nav.canGoBack() === false);

  // did-start/stop-loading drive the stop button and the sweep bar.
  const loadEvents = collect(wc, "did-start-loading", 3000);
  const stopEvents = collect(wc, "did-stop-loading", 3000);
  wc.loadURL(OTHER).catch(() => undefined);
  await wait(400);
  wc.loadFile(PAGE).catch(() => undefined);
  check("did-start-loading fires on a navigation", (await loadEvents).length > 0);
  check("did-stop-loading fires on a navigation", (await stopEvents).length > 0);
  await wait(400);
  check("history builds up, so Back can light", wc.navigationHistory.canGoBack());

  // find-in-page. Electron's `findNext` reads backwards from the name: TRUE
  // means "start a new session with this text", false means "step through the
  // session already running". The renderer has to send them that way round.
  wc.focus();
  await wait(200);
  const finds = [];
  wc.on("found-in-page", (_e, result) => finds.push(result));
  const settle = async () => {
    await wait(700);
    return finds.at(-1);
  };

  wc.findInPage("beta", { forward: true, findNext: true });
  let last = await settle();
  check("a new session reports every match", last?.matches === 3, JSON.stringify(last));
  check("a new session starts on the first match", last?.activeMatchOrdinal === 1, String(last?.activeMatchOrdinal));
  check("the last instalment is the final one", last?.finalUpdate === true, JSON.stringify(last));

  wc.findInPage("beta", { forward: true, findNext: false });
  last = await settle();
  check("stepping advances the ordinal", last?.activeMatchOrdinal === 2, String(last?.activeMatchOrdinal));

  wc.findInPage("beta", { forward: false, findNext: false });
  last = await settle();
  check("stepping backwards walks back", last?.activeMatchOrdinal === 1, String(last?.activeMatchOrdinal));

  wc.findInPage("nothinghere", { forward: true, findNext: true });
  last = await settle();
  check("a miss reports zero matches", last?.matches === 0, JSON.stringify(last));
  wc.stopFindInPage("clearSelection");

  // before-input-event on each view — the only way a browser window sees ⌘F,
  // since the application menu belongs to the main window.
  const seen = [];
  const named = [
    [page, "page"],
    [chrome, "chrome"],
    [sidebar, "sidebar"],
  ];
  for (const [view, name] of named) {
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.meta && String(input.key).toLowerCase() === "f") {
        seen.push(name);
        event.preventDefault();
      }
    });
  }
  for (const [view, name] of named) {
    view.webContents.focus();
    await wait(150);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "f", modifiers: ["meta"] });
    await wait(250);
    check(`⌘F is seen in the ${name} view`, seen.includes(name), JSON.stringify(seen));
  }

  // The taller find layout must not disturb the page view's own coordinates.
  relayout(true);
  await wait(150);
  check("the page drops below the find row", page.getBounds().y === 74, JSON.stringify(page.getBounds()));
  const inner = await wc.executeJavaScript("({x: window.scrollX, h: document.body.scrollHeight})", true);
  check("the page keeps its own coordinate space", inner.x === 0 && inner.h > 0, JSON.stringify(inner));
  relayout(false);
  await wait(150);

  // context-menu params: what showPageMenu builds its entries from.
  let params = null;
  wc.once("context-menu", (_e, p) => {
    params = p;
  });
  await wc.executeJavaScript(
    `(() => { const r = document.getElementById("a"); const s = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(r); s.removeAllRanges(); s.addRange(range); })()`,
    true,
  );
  wc.sendInputEvent({ type: "mouseDown", x: 40, y: 20, button: "right", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: 40, y: 20, button: "right", clickCount: 1 });
  await wait(600);
  check("context-menu fires on the page view", Boolean(params), "no event");
  check("context-menu carries the selection", String(params?.selectionText || "").includes("alpha"), params?.selectionText);
  check(
    "a menu can be built from those params",
    Menu.buildFromTemplate([{ role: "copy" }, { label: "Ask Nexora about this" }]).items.length === 2,
  );

  // capturePage is view-relative, so the chrome never lands in a screenshot.
  // Sizes come back in device pixels, hence the scale factor.
  const shot = await wc.capturePage().catch((error) => String(error));
  const size = typeof shot === "string" ? { error: shot } : shot.getSize();
  const expected = page.getBounds().height * win.getContentBounds().height ? page.getBounds().height : 0;
  check(
    "capturePage sees only the page view",
    typeof shot !== "string" && size.height > 0 && Math.abs(size.height / 2 - expected) < 4,
    `${JSON.stringify(size)} vs page ${expected}`,
  );

  // The Ask panel is scriptable, which is how answers stream into it.
  const ready = await chrome.webContents.executeJavaScript("document.readyState", true).catch((error) => String(error));
  check("the chrome view is scriptable", ready === "complete" || ready === "interactive", String(ready));

  // ---- what Nexora Live is built on --------------------------------------
  // Screen sharing rests on three pieces of Electron behaviour that are not
  // obvious and are not ours. There is no getUserMedia check here on purpose:
  // it reaches macOS, and a test that can raise a system dialog is a test that
  // can hang.
  const media = session.fromPartition("persist:probe");
  const askToShare = () =>
    wc.executeJavaScript(
      `navigator.mediaDevices.getDisplayMedia({ video: true })
         .then((s) => { s.getTracks().forEach((t) => t.stop()); return "stream"; })
         .catch((e) => "reject:" + e.name)`,
      true,
    );

  // 1. No handler is not "share everything" — it is "share nothing", silently.
  check("getDisplayMedia is dead without a handler", (await askToShare()) === "reject:NotSupportedError");

  // 2. The handler is reached, and answering with no source cancels the page's
  //    request by throwing back out of the callback. Both halves matter: the
  //    throw is the cancellation, and it has to be caught or it is an
  //    unhandled rejection in the main process.
  let asked = 0;
  let threw = false;
  media.setDisplayMediaRequestHandler(
    (_request, callback) => {
      asked += 1;
      try {
        callback({});
      } catch {
        threw = true;
      }
    },
    { useSystemPicker: false },
  );
  check("a handler is asked for a source", (await askToShare()) === "reject:AbortError" && asked === 1, String(asked));
  check("and answering with none cancels, by throwing", threw);

  // 3. A screen share asks permission under the microphone's name, with an
  //    empty mediaTypes — so a permission policy that keys off "media" has to
  //    let it through, and must not read the empty list as "audio".
  const requests = [];
  media.setPermissionRequestHandler((_contents, permission, callback, permissionDetails) => {
    requests.push({ permission, mediaTypes: permissionDetails && permissionDetails.mediaTypes });
    callback(false);
  });
  asked = 0;
  check("a denied permission never reaches the picker", (await askToShare()) === "reject:NotAllowedError" && asked === 0);
  check(
    "and it arrives as media with no media types",
    requests.length === 1 && requests[0].permission === "media" && (requests[0].mediaTypes || []).length === 0,
    JSON.stringify(requests),
  );
  media.setPermissionRequestHandler(null);
  media.setDisplayMediaRequestHandler(null);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});

app.on("window-all-closed", () => undefined);
setTimeout(() => {
  console.log("FAIL — probe timed out");
  app.exit(1);
}, 60_000);
