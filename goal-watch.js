"use strict";

/**
 * Goal watch — the native half of Goals.
 *
 * A goal runs on the Nexora runtime, not here, and the web chat this app loads
 * already has the Goals panel. What only a desktop app can add is the part
 * after you walk away: hand a goal over, close the window, and be told when it
 * needs you or has finished — a notification, a count on the Dock icon, and a
 * menu bar item that lists what is waiting.
 *
 * Two halves, kept apart on purpose:
 *
 *   createGoalWatch(host)  the watcher itself. No Electron, no clock, no disk
 *                          of its own: the page read, the timers, the store and
 *                          the notification are all handed in, so its pacing
 *                          and its decisions are tested in plain Node.
 *   attach(deps)           the thin Electron side: which page to read, the
 *                          Notification, the Dock badge, the Tray, and what a
 *                          click does.
 *
 * Rules this file keeps:
 *
 *  - The API key never leaves the page. The read happens INSIDE the Nexora
 *    page (`pageRead`, a fixed function with nothing spliced into it): it takes
 *    the key from the page's own storage, calls the page's own same-origin
 *    proxy, and hands back only ids, kinds, states and clipped text. The main
 *    process never sees, stores or logs the key.
 *  - Everything that comes back is untrusted — titles, questions and messages
 *    are written by agents, and by web pages those agents read. It is checked
 *    for type, length and id shape before use, shown as plain clipped text, and
 *    never reaches executeJavaScript, a shell, a file path or a URL.
 *  - A click only ever opens the app's own fixed address, and only names a
 *    goal whose id has the runtime's shape.
 *  - Nothing is logged but an outcome and counts (and only when asked for).
 */

const fs = require("node:fs");
const path = require("node:path");

/* ---- Pacing ----------------------------------------------------------------- */

const POLL_MS = 45_000; // between reads when all is well
const FIRST_POLL_MS = 8_000; // after launch: the page needs a moment to load
const POKE_MS = 2_500; // "look soon": a page just loaded, the switch was turned on
const MIN_GAP_MS = 10_000; // a poke never brings two reads closer together than this
const SIGNED_OUT_MS = 5 * 60_000; // signed out: nothing to ask, look again rarely
const BACKOFF_MAX_MS = 15 * 60_000; // a failing runtime is asked less and less, down to this
const READ_TIMEOUT_MS = 30_000; // the page read as a whole (each request inside it has 15 s)

/* ---- Limits ----------------------------------------------------------------- */

const ANNOUNCED_KEEP = 300; // remembered notification ids, newest kept
const BURST = 3; // more new events than this at once become one notification
const MAX_NOTIFICATIONS = 200; // the runtime's own ceiling on the list
const MAX_ACTORS = 100;
const PAGE_TITLE_MAX = 120; // what `pageRead` clips to; longer means it was not `pageRead` that answered
const PAGE_MESSAGE_MAX = 300;
const TITLE_MAX = 80; // a goal's title in a notification
const BODY_MAX = 240; // a question or a summary in a notification
const MENU_TITLE_MAX = 44; // a goal's title in the menu bar menu
const TRAY_GOALS = 8;

/* ---- The runtime's vocabulary ------------------------------------------------ */

const ACTOR_ID = /^actor_[0-9a-f]{8,40}$/;
const NOTIFICATION_ID = /^ntf_[0-9a-f]{8,40}_[0-9]{1,12}$/;
const ACTOR_STATES = new Set(["active", "sleeping", "paused", "suspended", "awaiting_input", "blocked", "done", "failed", "cancelled"]);
const PARKED_BY = new Set(["", "creator_revoked", "agent", "budget"]);

/**
 * The five transitions the runtime tells people about. `title` is this app's
 * own wording; `entered` is the state the goal was in when it was said, so an
 * event the goal has since moved on from (answered on your phone) is not news;
 * `needs` marks the ones that wait on the person; `count` words a summary.
 */
const KINDS = new Map([
  ["actor.awaiting_input", { title: "A goal has a question for you", entered: "awaiting_input", needs: true, count: (n) => (n === 1 ? "1 question" : `${n} questions`) }],
  ["actor.done", { title: "A goal is finished", entered: null, needs: false, count: (n) => `${n} finished` }],
  ["actor.blocked", { title: "A goal is stuck", entered: "blocked", needs: true, count: (n) => `${n} stuck` }],
  ["actor.budget_cap", { title: "A goal ran out of budget", entered: "blocked", needs: true, count: (n) => `${n} out of budget` }],
  ["actor.failed", { title: "A goal failed", entered: null, needs: false, count: (n) => `${n} failed` }],
]);

// The runtime's own codes, said in words. Anything else in these two kinds is
// a code we do not know, and a code is not worth showing a person.
const BUDGET_WORDS = new Map([
  ["cycle_cap", "It used all the steps it was given."],
  ["token_cap", "It used all the tokens it was given."],
  ["wall_cap", "It used all the time it was given."],
  ["usd_cap", "It used all the money it was given."],
]);
const BLOCKED_WORDS = new Map([
  ["creator_revoked", "The person who started it no longer has access."],
  ["conversation_busy", "Its thread was busy."],
]);

const UNTITLED = "Untitled goal";
// docs/actors.md, Notifications: a client must label what comes from a goal
// that reads the open web — a page it read can put words into its question.
const WEB_LABEL = "From a goal that reads the open web — a page may have shaped this.";
const WHY = { question: "has a question", stuck: "is stuck", budget: "is out of budget" };

/* ---- The two functions that run inside the page -------------------------------
 *
 * Each is sent to the page as its own source text and nothing else — no value
 * from the runtime, the disk or the user is ever spliced into it. They are
 * written as real functions (not strings) so that they are parsed with the
 * module and can be run in a test; they are never called in the main process.
 */

/* eslint-disable no-undef */

/**
 * Read what the watcher needs, from inside the Nexora page. Returns the page's
 * origin (checked again on this side), whether anyone is signed in, and for
 * each of the two lists whether it could be read and its clipped rows. The key
 * goes into one request header to this page's own origin, and nowhere else.
 */
async function pageRead() {
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const obj = (value) => (value && typeof value === "object" ? value : {});
  const web = (value) => Array.isArray(value) && value.includes("web");
  const origin = String(window.location.origin);

  let key = "";
  try {
    const held = obj(obj(JSON.parse(window.localStorage.getItem("nexora.session") || "null")).state).apiKey;
    if (typeof held === "string") key = held;
  } catch (error) {
    // Unreadable storage is the same as nobody signed in.
  }
  if (!key) return { origin, signedIn: false };

  const read = async (route, field, shape) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch("/api/nx" + route, { headers: { "x-api-key": key }, cache: "no-store", signal: controller.signal });
      if (!res.ok) return { ok: false, status: res.status, items: [] };
      const rows = obj(await res.json())[field];
      if (!Array.isArray(rows)) return { ok: false, status: res.status, items: [] };
      return { ok: true, status: res.status, items: rows.slice(0, 200).map(shape) };
    } catch (error) {
      return { ok: false, status: 0, items: [] };
    } finally {
      clearTimeout(timer);
    }
  };

  const [notifications, actors] = await Promise.all([
    read("/api/v1/notifications?scope=user&unread=true", "notifications", (row) => {
      const n = obj(row);
      const meta = obj(n.metadata);
      return {
        id: text(n.id, 80),
        kind: text(n.kind, 40),
        scope: text(n.scope, 20),
        read: n.read === true,
        resolved: Boolean(n.resolvedAt),
        createdAt: text(n.createdAt, 40),
        message: text(n.message, 300),
        actorId: text(meta.actorId, 60),
        actorTitle: text(meta.actorTitle, 120),
        web: web(meta.capabilities),
      };
    }),
    read("/api/v1/actors?mine=true&limit=100", "actors", (row) => {
      const a = obj(row);
      return {
        id: text(a.id, 60),
        title: text(a.title, 120) || text(a.intent, 120),
        state: text(a.state, 30),
        parkedBy: text(a.parkedBy, 30),
      };
    }),
  ]);
  return { origin, signedIn: true, notifications, actors };
}

/**
 * Open the Goals panel the way a person does: press the page's own Goals
 * button (goals-panel.tsx, `GoalsEntry` — it is labelled "Goals", or
 * "Goals — N need your attention"). Answers whether there was one to press.
 */
function pagePressGoals() {
  const button = document.querySelector('button[aria-label="Goals"], button[aria-label^="Goals — "]');
  if (!button) return false;
  button.click();
  return true;
}

/* eslint-enable no-undef */

const PAGE_READ_JS = `(${pageRead.toString()})()`;
const PAGE_PRESS_GOALS_JS = `(${pagePressGoals.toString()})()`;

/* ---- Untrusted text ----------------------------------------------------------- */

// Control characters, line and paragraph separators, zero-width characters and
// the bidi controls that can make text read as something it is not.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** One line of plain text, clipped: what a title or a message becomes before a person sees it. */
function plain(value, max) {
  if (typeof value !== "string") return "";
  const line = value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…` : line;
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value, max) => typeof value === "string" && value.length <= max;

/* ---- Checking what the page handed back ---------------------------------------- */

function cleanNotification(row) {
  if (!isObject(row)) return null;
  if (typeof row.id !== "string" || !NOTIFICATION_ID.test(row.id)) return null;
  if (typeof row.kind !== "string" || !KINDS.has(row.kind)) return null;
  if (typeof row.actorId !== "string" || !ACTOR_ID.test(row.actorId)) return null;
  // The caller's own mailbox, and unread: exactly what was asked for.
  if (row.scope !== "user" || row.read !== false) return null;
  if (typeof row.resolved !== "boolean" || typeof row.web !== "boolean") return null;
  if (!isText(row.message, PAGE_MESSAGE_MAX) || !isText(row.actorTitle, PAGE_TITLE_MAX) || !isText(row.createdAt, 40)) return null;
  const at = Date.parse(row.createdAt);
  return {
    id: row.id,
    kind: row.kind,
    actorId: row.actorId,
    resolved: row.resolved,
    web: row.web,
    message: row.message,
    actorTitle: row.actorTitle,
    at: Number.isFinite(at) ? at : 0,
  };
}

function cleanActor(row) {
  if (!isObject(row)) return null;
  if (typeof row.id !== "string" || !ACTOR_ID.test(row.id)) return null;
  if (typeof row.state !== "string" || !ACTOR_STATES.has(row.state)) return null;
  if (typeof row.parkedBy !== "string" || !PARKED_BY.has(row.parkedBy)) return null;
  if (!isText(row.title, PAGE_TITLE_MAX)) return null;
  return { id: row.id, state: row.state, parkedBy: row.parkedBy, title: row.title };
}

/** One of the two lists: `null` when it could not be read, otherwise the rows that passed, each id once. */
function cleanList(part, max, clean) {
  if (!isObject(part) || typeof part.ok !== "boolean" || !Array.isArray(part.items)) return { rows: null, status: 0 };
  const status = Number.isInteger(part.status) && part.status >= 0 && part.status <= 599 ? part.status : 0;
  if (!part.ok) return { rows: null, status };
  const rows = [];
  const seen = new Set();
  for (const row of part.items.slice(0, max)) {
    const item = clean(row);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(item);
  }
  return { rows, status };
}

/**
 * Everything the page returned, checked. `null` means the answer is not one
 * `pageRead` could have given (or came from another origin) and is thrown away
 * whole. Notifications come back oldest first.
 */
function validateRead(raw, origin) {
  if (!isObject(raw) || typeof raw.signedIn !== "boolean") return null;
  if (origin && raw.origin !== origin) return null;
  if (!raw.signedIn) return { signedIn: false, denied: false, notifications: null, actors: null };
  const notifications = cleanList(raw.notifications, MAX_NOTIFICATIONS, cleanNotification);
  const actors = cleanList(raw.actors, MAX_ACTORS, cleanActor);
  // The runtime lists newest first; said in the order they happened reads better.
  if (notifications.rows) notifications.rows.reverse().sort((a, b) => a.at - b.at);
  return {
    signedIn: true,
    // The key was refused: the same as signed out, and not something to keep asking about.
    denied: [notifications.status, actors.status].some((status) => status === 401 || status === 403),
    notifications: notifications.rows,
    actors: actors.rows,
  };
}

/** Waiting on the person: a question to answer, or parked until they resume it or raise its budget. */
function needsYou(goal) {
  return goal.state === "awaiting_input" || (goal.state === "blocked" && (goal.parkedBy === "agent" || goal.parkedBy === "budget"));
}

function whyNeeded(goal) {
  if (goal.state === "awaiting_input") return "question";
  return goal.parkedBy === "budget" ? "budget" : "stuck";
}

/* ---- What a notification says --------------------------------------------------- */

function describe(kind, message) {
  if (kind === "actor.budget_cap") return BUDGET_WORDS.get(message) || "";
  if (kind === "actor.failed") return "It stopped after repeated errors.";
  if (kind === "actor.blocked") {
    if (BLOCKED_WORDS.has(message)) return BLOCKED_WORDS.get(message);
    return plain(message.replace(/^agent:\s*/, ""), BODY_MAX);
  }
  return plain(message, BODY_MAX);
}

/** One event: this app's wording for the title; the goal's title and the clipped message as the body. */
function noteFor(event, goal) {
  const title = plain(event.actorTitle || (goal ? goal.title : ""), TITLE_MAX) || UNTITLED;
  const lines = [title, describe(event.kind, event.message)];
  if (event.web) lines.push(WEB_LABEL);
  return { title: KINDS.get(event.kind).title, body: lines.filter(Boolean).join("\n"), target: { view: "goal", goalId: event.actorId } };
}

/** Many at once: one notification, in this app's words only — counts, no text from the runtime. */
function summaryFor(events) {
  const goals = new Set(events.map((event) => event.actorId)).size;
  const allNeed = events.every((event) => KINDS.get(event.kind).needs);
  const counts = [];
  for (const [kind, spec] of KINDS) {
    const n = events.filter((event) => event.kind === kind).length;
    if (n) counts.push(spec.count(n));
  }
  let title;
  if (allNeed) title = goals === 1 ? "A goal needs you" : `${goals} goals need you`;
  else title = goals === 1 ? "A goal has news" : `${goals} goals have news`;
  return { title, body: counts.join(" · "), target: { view: "list" } };
}

/** What a click may ask the page for: one goal by a well-formed id, the new-goal form, or the list. */
function cleanTarget(target) {
  if (isObject(target) && target.view === "goal" && typeof target.goalId === "string" && ACTOR_ID.test(target.goalId)) {
    return { view: "goal", goalId: target.goalId };
  }
  if (isObject(target) && target.view === "new") return { view: "new" };
  return { view: "list" };
}

/* ---- What is kept on disk -------------------------------------------------------- */

/** The switch and the ids already announced, read back with nothing taken on trust. */
function cleanState(raw) {
  const state = { notify: true, announced: [] };
  if (!isObject(raw)) return state;
  if (typeof raw.notify === "boolean") state.notify = raw.notify;
  if (Array.isArray(raw.announced)) {
    const seen = new Set();
    for (const id of raw.announced.slice(-ANNOUNCED_KEEP * 2)) {
      if (typeof id !== "string" || !NOTIFICATION_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      state.announced.push(id);
    }
    state.announced = state.announced.slice(-ANNOUNCED_KEEP);
  }
  return state;
}

/** A JSON file beside the app's other settings. Unreadable or unwritable is not worth a crash. */
function fileStore(file) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const draft = `${file}.tmp`;
        fs.writeFileSync(draft, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(draft, file);
      } catch {
        // The ids stay in memory for this run; the next save tries again.
      }
    },
  };
}

/* ---- The watcher ------------------------------------------------------------------ */

/**
 * `host` is everything outside:
 *   readPage()            → what `pageRead` returned, or null when there is no trusted page to ask
 *   notify(note)          → show { title, body, target }
 *   setAttention(view)    → { count, goals: [{ id, title, why }] } changed
 *   isWatching()          → the person is looking at the app right now (optional)
 *   load() / save(state)  → the store
 *   now(), setTimer(fn, ms), clearTimer(handle)
 *   log(outcome, counts)  → optional; outcome names and numbers only
 */
function createGoalWatch(host, options = {}) {
  const origin = options.origin || null;
  const state = cleanState(host.load());

  let started = false;
  let timer = null;
  let nextAt = 0;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let epoch = 0; // bumped when the switch flips or the watcher stops: a read in flight then counts for nothing
  let inFlight = null; // the epoch of the read that is running, if any
  let running = Promise.resolve();
  let failures = 0;
  let signedOut = false;
  let attention = { count: 0, goals: [] };

  const save = () => host.save({ notify: state.notify, announced: state.announced });

  function setAttention(goals) {
    const next = { count: goals.length, goals };
    if (JSON.stringify(next) === JSON.stringify(attention)) return;
    attention = next;
    host.setAttention(attention);
  }

  function schedule(ms) {
    if (timer !== null) host.clearTimer(timer);
    const mine = epoch;
    nextAt = host.now() + ms;
    timer = host.setTimer(() => {
      timer = null;
      if (mine === epoch) void tick();
    }, ms);
  }

  function show(note) {
    try {
      host.notify(note);
    } catch {
      // A notification that cannot be shown is dropped: its id is already
      // remembered, so there is nothing to try again and no loop to fall into.
    }
  }

  /** Remember every new id first, then say what is still news. Returns how many notifications went out. */
  function announce(events, actors) {
    const known = new Set(state.announced);
    const goals = new Map((actors || []).map((goal) => [goal.id, goal]));
    const fresh = [];
    const remembered = [];
    for (const event of events) {
      if (known.has(event.id)) continue;
      known.add(event.id);
      remembered.push(event.id);
      if (event.resolved) continue; // a question already answered, or cancelled
      const goal = goals.get(event.actorId);
      const entered = KINDS.get(event.kind).entered;
      if (goal && entered && goal.state !== entered) continue; // the goal has moved on since
      fresh.push(event);
    }
    if (!remembered.length) return 0;
    state.announced = state.announced.concat(remembered).slice(-ANNOUNCED_KEEP);
    save();
    if (!fresh.length) return 0;
    // In front of the person, the page's own toasts say it; a second copy is noise.
    if (host.isWatching && host.isWatching()) return 0;
    if (fresh.length > BURST) {
      show(summaryFor(fresh));
      return 1;
    }
    for (const event of fresh) show(noteFor(event, goals.get(event.actorId)));
    return fresh.length;
  }

  async function read(mine) {
    const raw = await host.readPage();
    if (mine !== epoch) return { outcome: "off" };
    if (raw === null || raw === undefined) return { outcome: "skipped" };
    const result = validateRead(raw, origin);
    if (!result) {
      failures += 1;
      return { outcome: "failed", error: "bad_shape" };
    }
    if (!result.signedIn || result.denied) {
      signedOut = true;
      failures = 0;
      setAttention([]);
      return { outcome: "signed_out" };
    }
    signedOut = false;
    if (result.actors) {
      setAttention(
        result.actors.filter(needsYou).map((goal) => ({ id: goal.id, title: plain(goal.title, MENU_TITLE_MAX) || UNTITLED, why: whyNeeded(goal) })),
      );
    }
    const shown = result.notifications ? announce(result.notifications, result.actors) : 0;
    if (!result.notifications || !result.actors) {
      failures += 1;
      return { outcome: "failed", error: "http", shown, needs: attention.count };
    }
    failures = 0;
    return { outcome: "ok", shown, needs: attention.count };
  }

  function delayAfter(result) {
    if (result.outcome === "signed_out") return SIGNED_OUT_MS;
    if (result.outcome === "failed") return Math.min(POLL_MS * 2 ** Math.min(failures, 10), BACKOFF_MAX_MS);
    return POLL_MS;
  }

  /** One read, start to finish. Always resolves; says what happened. */
  function tick() {
    if (!state.notify) return Promise.resolve({ outcome: "off" });
    if (inFlight === epoch) return Promise.resolve({ outcome: "busy" });
    const mine = epoch;
    inFlight = mine;
    lastReadAt = host.now();
    const run = (async () => {
      let result;
      try {
        result = await read(mine);
      } catch (error) {
        failures += 1;
        result = { outcome: "failed", error: error && error.name === "TimeoutError" ? "timeout" : "page_error" };
      }
      if (inFlight === mine) inFlight = null;
      if (mine !== epoch) return { outcome: "off" };
      if (started) schedule(delayAfter(result));
      if (host.log) host.log(result.outcome, { error: result.error, shown: result.shown, needs: result.needs, failures });
      return result;
    })();
    running = run;
    return run;
  }

  /** Look soon — but never sooner than one already due, and never right on top of the last read. */
  function poke(ms = POKE_MS) {
    if (!started || !state.notify) return;
    const at = Math.max(host.now() + ms, lastReadAt + MIN_GAP_MS);
    if (timer !== null && nextAt <= at) return;
    schedule(at - host.now());
  }

  function setEnabled(on) {
    const next = Boolean(on);
    if (next === state.notify) return;
    state.notify = next;
    save();
    epoch += 1;
    failures = 0;
    signedOut = false;
    if (timer !== null) host.clearTimer(timer);
    timer = null;
    if (!next) setAttention([]);
    else if (started) schedule(POKE_MS);
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (state.notify) schedule(FIRST_POLL_MS);
    },
    stop() {
      started = false;
      epoch += 1;
      if (timer !== null) host.clearTimer(timer);
      timer = null;
    },
    tick,
    poke,
    /** A page finished loading: whoever is signed in may have changed. */
    pageLoaded: () => poke(),
    /** The page moved without loading (a sign-in does this): only worth a look if we were waiting for one. */
    pageMoved: () => {
      if (signedOut) poke();
    },
    setEnabled,
    isEnabled: () => state.notify,
    attention: () => attention,
    announced: () => state.announced.slice(),
    /** Resolves when the read that is running (if any) has finished. For tests. */
    idle: () => running.then(() => undefined),
  };
}

/* ---- The menu bar icon ------------------------------------------------------------- */

/**
 * A target — a ring and its centre — as raw BGRA, black with alpha, which is
 * what a macOS template image is: the system colours it for the menu bar,
 * light or dark. Drawn here rather than shipped as a file so there is no asset
 * to forget in the bundle.
 */
function iconBitmap(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = size / 2;
  const outer = size * 0.44;
  const inner = size * 0.31;
  const dot = size * 0.15;
  const SAMPLES = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const d = Math.hypot(x + (sx + 0.5) / SAMPLES - centre, y + (sy + 0.5) / SAMPLES - centre);
          if (d <= dot || (d >= inner && d <= outer)) hits += 1;
        }
      }
      pixels[(y * size + x) * 4 + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

/* ---- The Electron side -------------------------------------------------------------- */

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** `&` starts a keyboard mnemonic in a menu label; doubled, it is just an ampersand. */
const menuLabel = (text) => text.replace(/&/g, "&&");

/**
 * Wire the watcher to Electron.
 *
 *   deps.electron      { app, BrowserWindow, Tray, Menu, Notification, nativeImage }
 *   deps.getWindow()   the main window, or null
 *   deps.createWindow()
 *   deps.appUrl        the app's own address (APP_URL)
 *   deps.homeOrigin    its origin — the only one ever read from or sent to
 *   deps.userData      where the settings file goes
 *   deps.onChange()    the switch was flipped (the app menu shows it too)
 *
 * WHICH PAGE IS READ. While the main window exists, only it — and only when it
 * has finished loading a page on the app's origin; anywhere else (a sign-in
 * provider, a page still loading) the read is skipped. When the main window has
 * been closed, the app stays in the Dock and the watcher opens a small window
 * of its own that is never shown: no preload (so no bridge to this Mac), sandboxed,
 * holding the app's health-check address rather than the chat — same origin, so
 * the same stored sign-in and the same proxy, but none of the chat's code
 * running in the background. It is made on the first read after the window
 * closes, kept while it stays closed (starting a renderer every 45 seconds
 * would cost more than an idle one-line page), and destroyed the moment the
 * main window is back, the switch goes off, or nobody is signed in.
 *
 * The other choice — hiding the main window instead of closing it — was turned
 * down: "close" would stop meaning close. The whole chat would keep running
 * unseen, and a Nexora Live call with it, microphone open.
 */
function attach(deps) {
  const { app, BrowserWindow, Tray, Menu, Notification, nativeImage } = deps.electron;
  const home = deps.homeOrigin;
  const watchUrl = new URL("/api/healthz", home).toString();
  const store = fileStore(path.join(deps.userData, "goal-watch.json"));
  const debug = Boolean(process.env.NEXORA_GOAL_WATCH_DEBUG);

  let watcher = null; // the unseen window, while the main one is closed
  let tray = null;
  let hadMain = false;
  let sawSignedOut = false;
  let pending = null; // what the last click asked the page to open, until the page takes it
  let pendingSeq = 0;
  const shownNotes = new Set(); // kept so a notification is not collected before it is clicked

  const mainWindow = () => {
    const w = deps.getWindow();
    return w && !w.isDestroyed() ? w : null;
  };
  const onHome = (wc) => originOf(wc.getURL()) === home;
  /** The chat and code surfaces: the pages that have the Goals panel. */
  const onApp = (wc) => {
    if (!onHome(wc)) return false;
    const { pathname } = new URL(wc.getURL());
    return pathname === "/chat" || pathname.startsWith("/chat/") || pathname === "/code" || pathname.startsWith("/code/");
  };

  function dropWatcher() {
    const w = watcher;
    watcher = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  function openWatcher() {
    const w = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      focusable: false,
      skipTaskbar: true,
      // No preload: this page gets no bridge. It is read from, never listened to.
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    watcher = w;
    w.excludedFromShownWindowsMenu = true;
    w.webContents.setAudioMuted(true);
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // It holds one address on the app's origin and goes nowhere else.
    const stay = (event, url) => {
      if (originOf(url) !== home) event.preventDefault();
    };
    w.webContents.on("will-navigate", stay);
    w.webContents.on("will-redirect", stay);
    w.webContents.once("did-finish-load", () => watch.poke());
    w.on("closed", () => {
      if (watcher === w) watcher = null;
    });
    w.loadURL(watchUrl).catch(() => undefined);
  }

  /** The page this read may use, or null to skip it. */
  function pageToRead() {
    const main = mainWindow();
    if (main) {
      hadMain = true;
      dropWatcher();
      const wc = main.webContents;
      return !wc.isLoadingMainFrame() && onHome(wc) ? wc : null;
    }
    if (hadMain) {
      // The window was just closed. Whatever it last said about being signed
      // out may be stale (a sign-in, then a quick close): look once more.
      hadMain = false;
      sawSignedOut = false;
    }
    // Signing in takes the main window, so with nobody signed in and no window
    // there is nothing to wait for. (And off macOS a closed window is a quit.)
    if (process.platform !== "darwin" || sawSignedOut) return null;
    if (!watcher) {
      openWatcher(); // read on the look its did-finish-load asks for
      return null;
    }
    const wc = watcher.webContents;
    if (wc.isLoadingMainFrame()) return null;
    if (!onHome(wc)) {
      wc.loadURL(watchUrl).catch(() => undefined); // offline last time: try the address again
      return null;
    }
    return wc;
  }

  async function readPage() {
    const wc = pageToRead();
    if (!wc) return null;
    const raw = await withTimeout(wc.executeJavaScript(PAGE_READ_JS, false), READ_TIMEOUT_MS);
    if (raw && raw.signedIn === false) {
      sawSignedOut = true;
      dropWatcher();
    } else if (raw && raw.signedIn === true) {
      sawSignedOut = false;
    }
    return raw;
  }

  function notify(note) {
    // Notifications switched off for this app in System Settings: show() does
    // nothing and nothing is retried — the Dock badge and the menu bar carry on.
    if (!Notification.isSupported()) return;
    const native = new Notification({ title: note.title, body: note.body });
    const forget = () => shownNotes.delete(native);
    native.on("click", () => {
      forget();
      open(note.target);
    });
    native.on("close", forget);
    native.on("failed", forget);
    shownNotes.add(native);
    if (shownNotes.size > 20) shownNotes.delete(shownNotes.values().next().value);
    native.show();
  }

  function trayMenu() {
    const on = watch.isEnabled();
    const { count, goals } = watch.attention();
    const items = [];
    if (!on) {
      items.push({ label: "Goal notifications are off", enabled: false });
    } else if (!count) {
      items.push({ label: "No goals need you", enabled: false });
    } else {
      items.push({ label: count === 1 ? "1 goal needs you" : `${count} goals need you`, enabled: false });
      for (const goal of goals.slice(0, TRAY_GOALS)) {
        items.push({ label: menuLabel(`${goal.title} — ${WHY[goal.why]}`), click: () => open({ view: "goal", goalId: goal.id }) });
      }
      if (count > TRAY_GOALS) items.push({ label: `…and ${count - TRAY_GOALS} more`, enabled: false });
    }
    items.push(
      { type: "separator" },
      { label: "Open Goals", click: () => open({ view: "list" }) },
      { label: "New Goal…", click: () => open({ view: "new" }) },
      { type: "separator" },
      { label: "Notify me about goals", type: "checkbox", checked: on, click: (item) => setEnabled(item.checked) },
    );
    return Menu.buildFromTemplate(items);
  }

  /** The Dock badge and the menu bar item, from what the watcher last learned. */
  function paint() {
    const count = watch.isEnabled() ? watch.attention().count : 0;
    if (app.dock) app.dock.setBadge(count > 0 ? String(count) : "");
    if (tray && !tray.isDestroyed()) {
      tray.setTitle(count > 0 ? String(count) : "");
      tray.setToolTip(count > 0 ? `Nexora — ${count} goal${count === 1 ? " needs" : "s need"} you` : "Nexora goals");
      tray.setContextMenu(trayMenu());
    }
  }

  function makeTray() {
    try {
      const icon = nativeImage.createFromBitmap(iconBitmap(18), { width: 18, height: 18, scaleFactor: 1 });
      icon.addRepresentation({ scaleFactor: 2, width: 36, height: 36, buffer: iconBitmap(36) });
      icon.setTemplateImage(true);
      tray = new Tray(icon);
    } catch {
      tray = null; // No menu bar item is not a reason to lose the rest.
    }
  }

  function setEnabled(on) {
    watch.setEnabled(on);
    if (!watch.isEnabled()) dropWatcher();
    paint();
    if (deps.onChange) deps.onChange();
  }

  /**
   * Bring the window forward and ask the page for a goal, the list, or the
   * new-goal form.
   *
   * The page is asked in the way it already knows for scheduled tasks: a nudge
   * (`nexora:goal-target`), and the page comes and TAKES the target
   * (`nexoraLocal.takeGoalTarget()`), once. A web build that does not know the
   * nudge yet never takes it, so after a moment the Goals button is pressed for
   * it instead — the panel opens on the list, where what needs you is on top.
   * Nothing here builds a URL from a goal: the only address ever loaded is the
   * app's own.
   */
  function open(target) {
    pending = cleanTarget(target);
    pendingSeq += 1;
    const seq = pendingSeq;
    let w = mainWindow();
    if (!w) {
      deps.createWindow();
      w = mainWindow();
    }
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
    void deliver(w, seq).catch(() => undefined);
  }

  async function deliver(w, seq) {
    const current = () => seq === pendingSeq && pending !== null && !w.isDestroyed();
    const giveUp = () => {
      if (seq === pendingSeq) pending = null;
    };
    const wc = w.webContents;
    if (!wc.isLoadingMainFrame() && !onApp(wc)) await wc.loadURL(deps.appUrl).catch(() => undefined);
    for (let i = 0; i < 80 && current() && wc.isLoadingMainFrame(); i += 1) await sleep(250);
    if (!current() || !onApp(wc)) return giveUp();
    wc.send("nexora:goal-target");
    // Up to about eight seconds: after a fresh load the button is only there
    // once the page has asked the runtime whether Goals exist.
    for (let i = 0; i < 20; i += 1) {
      await sleep(i === 0 ? 700 : 400);
      if (!current()) return undefined; // the page took it, or a newer click replaced it
      if (!onApp(wc)) break;
      const pressed = await wc.executeJavaScript(PAGE_PRESS_GOALS_JS, true).catch(() => false);
      if (pressed === true) break;
    }
    return giveUp();
  }

  const watch = createGoalWatch(
    {
      readPage,
      notify,
      setAttention: () => paint(),
      isWatching: () => {
        const w = mainWindow();
        return Boolean(w && w.isFocused() && onApp(w.webContents));
      },
      load: store.load,
      save: store.save,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
      // Outcome names and counts, never anything the runtime said.
      log: debug ? (outcome, counts) => console.log("[goal-watch]", outcome, JSON.stringify(counts)) : null,
    },
    { origin: home },
  );

  return {
    start() {
      makeTray();
      paint();
      watch.start();
    },
    stop() {
      watch.stop();
      dropWatcher();
    },
    open,
    /** The page collects what the last click asked for. Handed over once. */
    takeTarget() {
      const target = pending;
      pending = null;
      return target;
    },
    isEnabled: watch.isEnabled,
    setEnabled,
    pageLoaded: watch.pageLoaded,
    pageMoved: watch.pageMoved,
    /** True for the unseen window, so "no windows open" can still mean what it says. */
    ownsWindow: (w) => Boolean(watcher) && w === watcher,
  };
}

module.exports = {
  createGoalWatch,
  attach,
  fileStore,
  validateRead,
  cleanState,
  cleanTarget,
  needsYou,
  plain,
  noteFor,
  summaryFor,
  iconBitmap,
  PAGE_READ_JS,
  PAGE_PRESS_GOALS_JS,
  ACTOR_ID,
  NOTIFICATION_ID,
  POLL_MS,
  FIRST_POLL_MS,
  POKE_MS,
  MIN_GAP_MS,
  SIGNED_OUT_MS,
  BACKOFF_MAX_MS,
  ANNOUNCED_KEEP,
  BURST,
  TRAY_GOALS,
  PAGE_MESSAGE_MAX,
};
