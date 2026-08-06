const { desktopCapturer, screen, systemPreferences, clipboard, shell, app } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Nexora Desktop — Computer Use.
 *
 * The agent looks at this Mac and drives it: screenshots, the pointer, the
 * keyboard. Everything below is built out of what macOS already ships, so the
 * app stays a pure-JavaScript build with no native module to compile or sign:
 *
 *   seeing   Electron's desktopCapturer, which is the Screen Recording API
 *   doing    CoreGraphics events posted through JXA (`osascript -l JavaScript`)
 *
 * Both are gated by macOS privacy permissions the user grants once, to Nexora
 * Desktop specifically — Screen Recording to see, Accessibility to act. Until
 * they are granted every call returns an error that says which pane to open.
 *
 * The screenshot defines the coordinate space. Whatever size the image comes
 * back at is the space the agent clicks in, and we scale back to display points
 * before posting the event. That is the same contract Anthropic's computer-use
 * tool uses, and it is the one thing here that must not drift: a click computed
 * against a stale or differently-scaled image lands somewhere else entirely.
 */

// A screenshot the model can actually read without costing a fortune. Wider
// than this buys no accuracy on a 1680-point display; narrower starts losing
// menu-bar text.
const SHOT_WIDTH = 1400;
const SHOT_QUALITY = 70;
const BATCH_MAX_ACTIONS = 32;
const ACTION_MAX_WAIT = 30; // seconds any single wait/hold may ask for

/**
 * How much of the machine the agent may drive, decided by whatever is in front.
 *
 * Ported from Anthropic's computer-use policy, and for the same reasons. A
 * browser is the one surface where a stray click can spend money or send mail
 * on a logged-in account, and Nexora has a real browser tool that works on the
 * page rather than on pixels — so here a browser is look-only. A terminal or an
 * editor will execute whatever is typed into it, so the pointer is allowed and
 * the keyboard is not. Everything else is fair game.
 */
const READ_ONLY_APPS = [/chrome/i, /safari/i, /firefox/i, /microsoft edge/i, /^arc$/i, /brave/i, /opera/i, /vivaldi/i, /chromium/i];
const CLICK_ONLY_APPS = [
  /terminal/i,
  /iterm/i,
  /warp/i,
  /ghostty/i,
  /alacritty/i,
  /kitty/i,
  /hyper/i,
  /visual studio code/i,
  /^code$/i,
  /cursor/i,
  /windsurf/i,
  /xcode/i,
  /intellij/i,
  /pycharm/i,
  /webstorm/i,
  /goland/i,
  /rubymine/i,
  /android studio/i,
  /^zed$/i,
  /sublime text/i,
  /nova/i,
  /emacs/i,
];

function tierFor(appName) {
  const name = String(appName || "");
  if (READ_ONLY_APPS.some((re) => re.test(name))) return "read";
  if (CLICK_ONLY_APPS.some((re) => re.test(name))) return "click";
  return "full";
}

const POINTER_ACTIONS = new Set([
  "mouse_move",
  "left_click",
  "double_click",
  "triple_click",
  "middle_click",
  "left_mouse_down",
  "left_mouse_up",
  "left_click_drag",
  "scroll",
  "cursor_position",
  "wait",
]);
const TYPING_ACTIONS = new Set(["type", "key", "hold_key"]);

// ---------------------------------------------------------------------------
// Talking to macOS
// ---------------------------------------------------------------------------

function osa(args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout).trim());
    });
  });
}

async function frontmostApp() {
  try {
    return await osa(["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], 5000);
  } catch {
    return "";
  }
}

/**
 * The two privacy permissions this tool needs, and whether we have them.
 *
 * Accessibility is checked without prompting; `request` flips that, which pops
 * the system dialog exactly once and then never again — after a denial the user
 * has to go to Settings, so we hand them the deep link rather than a shrug.
 */
function accessStatus(request = false) {
  const screenAccess = systemPreferences.getMediaAccessStatus("screen");
  const accessibility = systemPreferences.isTrustedAccessibilityClient(Boolean(request));
  return {
    screenRecording: screenAccess,
    accessibility: accessibility ? "granted" : "denied",
    canSee: screenAccess === "granted",
    canAct: accessibility,
    settings: {
      screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    },
  };
}

// ---------------------------------------------------------------------------
// Seeing
// ---------------------------------------------------------------------------

function displayList() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.map((d, index) => ({
    index,
    id: d.id,
    primary: d.id === primary.id,
    width: d.size.width,
    height: d.size.height,
    x: d.bounds.x,
    y: d.bounds.y,
    scale: d.scaleFactor,
  }));
}

function pickDisplay(which) {
  const displays = screen.getAllDisplays();
  if (which === undefined || which === null || which === "") return screen.getPrimaryDisplay();
  const index = Number(which);
  if (Number.isFinite(index) && displays[index]) return displays[index];
  const byId = displays.find((d) => String(d.id) === String(which));
  if (byId) return byId;
  throw new Error(`No display ${which}. Displays: ${displayList().map((d) => d.index).join(", ")}.`);
}

/**
 * Photograph a display.
 *
 * `region` crops before scaling, which is how you read small text: a crop of a
 * quarter of the screen rendered at the same width is a 4x zoom. Crop
 * coordinates are in the *previous* screenshot's space, like every other
 * coordinate the agent hands us.
 */
async function screenshot(input = {}) {
  const status = accessStatus();
  if (!status.canSee) {
    throw new Error(
      "Screen Recording is not granted to Nexora Desktop, so it cannot see the screen. " +
        "Open System Settings → Privacy & Security → Screen & System Audio Recording, switch Nexora Desktop on, then relaunch the app."
    );
  }

  const display = pickDisplay(input.display);
  const ratio = display.size.height / display.size.width;
  const grabWidth = Math.round(display.size.width * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: grabWidth, height: Math.round(grabWidth * ratio) },
    fetchWindowIcons: false,
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("macOS returned an empty screen capture. Check Screen Recording permission and try again.");

  let image = source.thumbnail;
  const full = image.getSize();
  let crop = null;

  if (Array.isArray(input.region) && input.region.length === 4) {
    // The region arrives in the coordinate space of the last screenshot, which
    // was itself scaled to SHOT_WIDTH. Convert to this capture's pixels first.
    const previousWidth = Number(input.regionWidth) || SHOT_WIDTH;
    const k = full.width / previousWidth;
    const [rx, ry, rw, rh] = input.region.map(Number);
    crop = {
      x: Math.max(0, Math.round(rx * k)),
      y: Math.max(0, Math.round(ry * k)),
      width: Math.max(16, Math.round(rw * k)),
      height: Math.max(16, Math.round(rh * k)),
    };
    crop.width = Math.min(crop.width, full.width - crop.x);
    crop.height = Math.min(crop.height, full.height - crop.y);
    image = image.crop(crop);
  }

  const size = image.getSize();
  const width = Math.min(Number(input.width) || SHOT_WIDTH, size.width);
  if (width < size.width) image = image.resize({ width, quality: "good" });

  const shown = image.getSize();
  const buffer = image.toJPEG(Number(input.quality) || SHOT_QUALITY);

  let savedTo;
  if (input.saveToDisk) {
    try {
      savedTo = path.join(app.getPath("downloads"), `nexora-screen-${Date.now()}.png`);
      fs.writeFileSync(savedTo, image.toPNG());
    } catch {
      savedTo = undefined;
    }
  }

  return {
    display: displayList().find((d) => d.id === display.id),
    // Everything the agent needs to turn a pixel in this image back into a
    // point on the screen — and everything WE need on the next call.
    width: shown.width,
    height: shown.height,
    region: crop ? [crop.x, crop.y, crop.width, crop.height] : undefined,
    frontmost: await frontmostApp(),
    savedTo,
    image: { mediaType: "image/jpeg", dataBase64: buffer.toString("base64") },
  };
}

// ---------------------------------------------------------------------------
// Doing — CoreGraphics events, posted from a JXA helper
// ---------------------------------------------------------------------------

/**
 * The JXA driver.
 *
 * Written to a temp file at first use rather than shipped as a resource: the
 * app bundle is asar-packed and `osascript` cannot read a path inside an
 * archive. It takes a JSON payload file, runs the actions in order, and stops
 * at the first failure — a half-finished form is easier to reason about than
 * one where step three silently did nothing.
 */
const DRIVER_JS = String.raw`
ObjC.import('CoreGraphics');
ObjC.import('Foundation');

var KEYS = {
  a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,
  '1':18,'2':19,'3':20,'4':21,'6':22,'5':23,'=':24,'9':25,'7':26,'-':27,'8':28,'0':29,
  ']':30,o:31,u:32,'[':33,i:34,p:35,l:37,j:38,"'":39,k:40,';':41,'\\':42,',':43,'/':44,
  n:45,m:46,'.':47,'` + "`" + `':50,
  return:36, enter:36, tab:48, space:49, delete:51, backspace:51, escape:53, esc:53,
  left:123, right:124, down:125, up:126,
  home:115, end:119, pageup:116, pagedown:121, forwarddelete:117,
  f1:122,f2:120,f3:99,f4:118,f5:96,f6:97,f7:98,f8:100,f9:101,f10:109,f11:103,f12:111
};

function flagFor(name) {
  if (name === 'cmd' || name === 'command' || name === 'super') return $.kCGEventFlagMaskCommand;
  if (name === 'shift') return $.kCGEventFlagMaskShift;
  if (name === 'alt' || name === 'option' || name === 'opt') return $.kCGEventFlagMaskAlternate;
  if (name === 'ctrl' || name === 'control') return $.kCGEventFlagMaskControl;
  if (name === 'fn') return $.kCGEventFlagMaskSecondaryFn;
  return null;
}

function parseCombo(text) {
  var parts = String(text).toLowerCase().split(/[+\-]|\s+/).filter(function (p) { return p.length; });
  // A bare "-" or "+" is the key itself, not a separator.
  if (!parts.length) parts = [String(text).toLowerCase()];
  var flags = 0;
  var key = null;
  for (var i = 0; i < parts.length; i++) {
    var flag = flagFor(parts[i]);
    if (flag !== null) flags = flags | flag;
    else key = parts[i];
  }
  if (key === null) throw new Error('no key in combo "' + text + '"');
  var code = KEYS[key];
  if (code === undefined) throw new Error('unknown key "' + key + '"');
  return { code: code, flags: flags };
}

function post(event) { $.CGEventPost($.kCGHIDEventTap, event); }

function moveTo(x, y) {
  post($.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, { x: x, y: y }, $.kCGMouseButtonLeft));
}

function mouseEvent(type, x, y, button, clicks) {
  var e = $.CGEventCreateMouseEvent($(), type, { x: x, y: y }, button);
  if (clicks > 1) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks);
  post(e);
  return e;
}

function click(x, y, button, clicks, flags) {
  var down = button === 'right' ? $.kCGEventRightMouseDown : button === 'middle' ? $.kCGEventOtherMouseDown : $.kCGEventLeftMouseDown;
  var up = button === 'right' ? $.kCGEventRightMouseUp : button === 'middle' ? $.kCGEventOtherMouseUp : $.kCGEventLeftMouseUp;
  var which = button === 'right' ? $.kCGMouseButtonRight : button === 'middle' ? $.kCGMouseButtonCenter : $.kCGMouseButtonLeft;
  moveTo(x, y);
  for (var n = 1; n <= clicks; n++) {
    var d = $.CGEventCreateMouseEvent($(), down, { x: x, y: y }, which);
    if (n > 1) $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, n);
    if (flags) $.CGEventSetFlags(d, flags);
    post(d);
    var u = $.CGEventCreateMouseEvent($(), up, { x: x, y: y }, which);
    if (n > 1) $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, n);
    if (flags) $.CGEventSetFlags(u, flags);
    post(u);
    delay(0.04);
  }
}

function tapKey(code, flags) {
  var down = $.CGEventCreateKeyboardEvent($(), code, true);
  if (flags) $.CGEventSetFlags(down, flags);
  post(down);
  delay(0.02);
  var up = $.CGEventCreateKeyboardEvent($(), code, false);
  if (flags) $.CGEventSetFlags(up, flags);
  post(up);
}

/** Unicode straight onto the event, so any character types without a keymap. */
function typeText(text) {
  var chunk = 16;
  for (var i = 0; i < text.length; i += chunk) {
    var piece = text.slice(i, i + chunk);
    var ns = $.NSString.alloc.initWithUTF8String(piece);
    var down = $.CGEventCreateKeyboardEvent($(), 0, true);
    $.CGEventKeyboardSetUnicodeString(down, ns.length, ns);
    post(down);
    var up = $.CGEventCreateKeyboardEvent($(), 0, false);
    $.CGEventKeyboardSetUnicodeString(up, ns.length, ns);
    post(up);
    delay(0.012);
  }
}

function scroll(x, y, direction, amount) {
  if (x !== null) moveTo(x, y);
  var vertical = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
  var horizontal = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
  for (var i = 0; i < Math.abs(vertical || horizontal); i++) {
    var e = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2,
      vertical ? (vertical > 0 ? 1 : -1) : 0, horizontal ? (horizontal > 0 ? 1 : -1) : 0);
    post(e);
    delay(0.02);
  }
}

function cursor() {
  var p = $.CGEventGetLocation($.CGEventCreate($()));
  return [Math.round(p.x), Math.round(p.y)];
}

function one(step) {
  var c = step.coordinate || [];
  var s = step.start_coordinate || [];
  switch (step.action) {
    case 'cursor_position': return { position: cursor() };
    case 'mouse_move': moveTo(c[0], c[1]); return {};
    case 'left_click': click(c[0], c[1], 'left', 1, step.flags || 0); return {};
    case 'double_click': click(c[0], c[1], 'left', 2, step.flags || 0); return {};
    case 'triple_click': click(c[0], c[1], 'left', 3, step.flags || 0); return {};
    case 'right_click': click(c[0], c[1], 'right', 1, step.flags || 0); return {};
    case 'middle_click': click(c[0], c[1], 'middle', 1, step.flags || 0); return {};
    case 'left_mouse_down': mouseEvent($.kCGEventLeftMouseDown, c[0], c[1], $.kCGMouseButtonLeft, 1); return {};
    case 'left_mouse_up': mouseEvent($.kCGEventLeftMouseUp, c[0], c[1], $.kCGMouseButtonLeft, 1); return {};
    case 'left_click_drag':
      moveTo(s[0], s[1]);
      mouseEvent($.kCGEventLeftMouseDown, s[0], s[1], $.kCGMouseButtonLeft, 1);
      delay(0.08);
      // Move in steps: a single jump reads as a teleport and many apps ignore it.
      var steps = 12;
      for (var i = 1; i <= steps; i++) {
        var x = s[0] + ((c[0] - s[0]) * i) / steps;
        var y = s[1] + ((c[1] - s[1]) * i) / steps;
        post($.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDragged, { x: x, y: y }, $.kCGMouseButtonLeft));
        delay(0.02);
      }
      mouseEvent($.kCGEventLeftMouseUp, c[0], c[1], $.kCGMouseButtonLeft, 1);
      return {};
    case 'scroll':
      scroll(c.length ? c[0] : null, c.length ? c[1] : null, step.scroll_direction || 'down', Math.max(1, Math.min(Number(step.scroll_amount) || 3, 50)));
      return {};
    case 'type': typeText(String(step.text || '')); return {};
    case 'key': {
      var combo = parseCombo(step.text);
      var repeat = Math.max(1, Math.min(Number(step.repeat) || 1, 50));
      for (var r = 0; r < repeat; r++) { tapKey(combo.code, combo.flags); delay(0.03); }
      return {};
    }
    case 'hold_key': {
      var held = parseCombo(step.text);
      var down = $.CGEventCreateKeyboardEvent($(), held.code, true);
      if (held.flags) $.CGEventSetFlags(down, held.flags);
      post(down);
      delay(Math.max(0.1, Math.min(Number(step.duration) || 1, 30)));
      var up = $.CGEventCreateKeyboardEvent($(), held.code, false);
      if (held.flags) $.CGEventSetFlags(up, held.flags);
      post(up);
      return {};
    }
    case 'wait': delay(Math.max(0.1, Math.min(Number(step.duration) || 1, 30))); return {};
    default: throw new Error('unknown action "' + step.action + '"');
  }
}

function run(argv) {
  var file = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, $());
  var payload = JSON.parse(ObjC.unwrap(file));
  var done = [];
  for (var i = 0; i < payload.actions.length; i++) {
    var step = payload.actions[i];
    try {
      var extra = one(step);
      done.push(Object.assign({ action: step.action, ok: true }, extra));
    } catch (error) {
      done.push({ action: step.action, ok: false, error: String(error.message || error) });
      return JSON.stringify({ ok: false, completed: done, failedAt: i });
    }
    if (step.pause) delay(Math.min(Number(step.pause), 5));
    else delay(0.12);
  }
  return JSON.stringify({ ok: true, completed: done });
}
`;

let driverPath = null;
function driver() {
  if (driverPath && fs.existsSync(driverPath)) return driverPath;
  driverPath = path.join(os.tmpdir(), `nexora-computer-${process.pid}.js`);
  fs.writeFileSync(driverPath, DRIVER_JS, "utf8");
  return driverPath;
}

const MODIFIER_FLAGS = { cmd: 1 << 20, command: 1 << 20, shift: 1 << 17, alt: 1 << 19, option: 1 << 19, ctrl: 1 << 18, control: 1 << 18 };

/**
 * Turn a coordinate in screenshot space into one in display points.
 *
 * `imageWidth` is what the agent was looking at. Getting this wrong is the
 * classic computer-use bug — a Retina screen photographed at 1400px and clicked
 * at face value lands at roughly half the intended position — so the agent
 * always tells us which screenshot it measured against, and we scale.
 */
function toScreenPoint(coordinate, context) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) return coordinate;
  const [x, y] = coordinate.map(Number);
  const k = context.imageWidth ? context.display.width / context.imageWidth : 1;
  const offsetX = context.region ? context.region[0] * (context.display.width / context.captureWidth) : 0;
  const offsetY = context.region ? context.region[1] * (context.display.width / context.captureWidth) : 0;
  return [Math.round(context.display.x + offsetX + x * k), Math.round(context.display.y + offsetY + y * k)];
}

async function perform(actions, input) {
  const status = accessStatus();
  if (!status.canAct) {
    throw new Error(
      "Accessibility is not granted to Nexora Desktop, so it cannot move the pointer or type. " +
        "Open System Settings → Privacy & Security → Accessibility, switch Nexora Desktop on, then try again. " +
        'Calling computer_apps with op:"access" pops the system prompt.'
    );
  }

  const frontmost = await frontmostApp();
  const tier = tierFor(frontmost);
  for (const step of actions) {
    const name = String(step.action || "");
    if (tier === "read" && name !== "cursor_position" && name !== "wait") {
      throw new Error(
        `${frontmost} is in front, and Nexora only looks at browsers — it does not click in them. ` +
          "Use the browser_* tools, which drive a real page by element rather than by pixel, or switch to another app first."
      );
    }
    if (tier === "click" && (TYPING_ACTIONS.has(name) || name === "right_click")) {
      throw new Error(
        `${frontmost} runs whatever is typed into it, so Nexora will not type there. ` +
          "Pointer actions are allowed. To run a command, use local_shell or local_process instead."
      );
    }
    if (!POINTER_ACTIONS.has(name) && !TYPING_ACTIONS.has(name)) {
      throw new Error(`Unknown action "${name}".`);
    }
  }

  const display = displayList().find((d) => d.id === pickDisplay(input.display).id);
  const context = {
    display,
    imageWidth: Number(input.imageWidth) || SHOT_WIDTH,
    captureWidth: Number(input.captureWidth) || Number(input.imageWidth) || SHOT_WIDTH,
    region: Array.isArray(input.region) && input.region.length === 4 ? input.region.map(Number) : null,
  };

  const payload = {
    actions: actions.slice(0, BATCH_MAX_ACTIONS).map((step) => {
      const out = { ...step };
      if (out.coordinate) out.coordinate = toScreenPoint(out.coordinate, context);
      if (out.start_coordinate) out.start_coordinate = toScreenPoint(out.start_coordinate, context);
      if (out.duration) out.duration = Math.min(Number(out.duration), ACTION_MAX_WAIT);
      if (Array.isArray(step.holdKeys)) {
        out.flags = step.holdKeys.reduce((flags, key) => flags | (MODIFIER_FLAGS[String(key).toLowerCase()] || 0), 0);
      }
      return out;
    }),
  };

  const file = path.join(os.tmpdir(), `nexora-actions-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  try {
    const raw = await osa(["-l", "JavaScript", driver(), file], 120_000);
    const result = JSON.parse(raw || "{}");
    return { ...result, frontmost, tier };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // A leftover temp file in /tmp is not worth a failed tool call.
    }
  }
}

// ---------------------------------------------------------------------------
// The desktop around the pointer
// ---------------------------------------------------------------------------

async function appsTool(input) {
  const op = String(input.op || "list");
  if (op === "list") {
    const names = await osa([
      "-e",
      'tell application "System Events" to get name of every application process whose background only is false',
    ]);
    const apps = names
      .split(", ")
      .map((n) => n.trim())
      .filter(Boolean)
      .sort();
    return {
      frontmost: await frontmostApp(),
      // The tier is the useful half of this list: it tells the agent up front
      // where it may type, instead of finding out by being refused.
      apps: apps.map((name) => ({ name, access: tierFor(name) })),
      displays: displayList(),
    };
  }
  if (op === "open") {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("name is required");
    await new Promise((resolve, reject) => {
      execFile("open", ["-a", name], { timeout: 15_000 }, (error) => (error ? reject(new Error(`Could not open ${name}.`)) : resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { opened: name, frontmost: await frontmostApp() };
  }
  if (op === "access") {
    const status = accessStatus(true);
    if (!status.canSee && input.openSettings !== false) shell.openExternal(status.settings.screenRecording);
    else if (!status.canAct && input.openSettings !== false) shell.openExternal(status.settings.accessibility);
    return status;
  }
  if (op === "clipboard") {
    if (typeof input.text === "string") {
      clipboard.writeText(input.text);
      return { wrote: input.text.length };
    }
    return { text: clipboard.readText().slice(0, 20_000) };
  }
  throw new Error(`Unknown op: ${op}. Use list, open, access or clipboard.`);
}

// ---------------------------------------------------------------------------

/**
 * Run one computer-use call.
 *
 * `confirm` is the same native permission gate the file and browser tools use;
 * looking at the screen asks for it too, because a screenshot of this machine
 * is at least as sensitive as reading one of its files.
 */
async function runComputer(action, input = {}, options = {}) {
  const confirm = options.confirm || (async () => true);
  const describe = () => {
    if (action === "screenshot") return `take a picture of the screen${input.region ? " (a region of it)" : ""}`;
    if (action === "apps") return `${input.op || "list"} ${input.name || ""}`.trim();
    const list = action === "batch" ? input.actions || [] : [input];
    return list
      .slice(0, 8)
      .map((step) => `${step.action}${step.text ? ` "${String(step.text).slice(0, 60)}"` : ""}${step.coordinate ? ` at ${step.coordinate}` : ""}`)
      .join("\n");
  };

  if (action !== "apps" || input.op !== "access") {
    if (!(await confirm("computer", describe()))) throw new Error("Permission denied by the user.");
  }

  switch (action) {
    case "screenshot":
      return { ok: true, ...(await screenshot(input)) };
    case "action":
      return { ok: true, ...(await perform([input], input)) };
    case "batch": {
      const actions = Array.isArray(input.actions) ? input.actions : [];
      if (!actions.length) throw new Error("actions is required — a list of steps to run in order.");
      return { ok: true, ...(await perform(actions, input)) };
    }
    case "apps":
      return { ok: true, ...(await appsTool(input)) };
    default:
      throw new Error(`Unknown computer action: ${action}`);
  }
}

module.exports = { runComputer, accessStatus, frontmostApp, tierFor, displayList, SHOT_WIDTH };
