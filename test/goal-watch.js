/**
 * The goal watcher (`goal-watch.js`): what it asks the page for, what it does
 * with the answer, and when it asks again.
 *
 * Plain Node, no Electron. The watcher takes its page read, its timers, its
 * store and its notification as arguments, so here the page is a function that
 * returns whatever the test says, the clock only moves when told to, and a
 * "notification" is a row in an array. The two functions that run inside the
 * real page are run here too, in a `vm` context with a fake `localStorage` and
 * `fetch` — which is how "the key never comes back" gets checked rather than
 * asserted.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const watchLib = require("../goal-watch");

const ORIGIN = "https://nexora.example";
const A1 = "actor_3f9c1a2b4d5e6f70";
const A2 = "actor_0123456789abcdef";
const A3 = "actor_aaaaaaaaaaaaaaaa";

/* ---- Fixtures: rows as `pageRead` returns them ---------------------------------- */

let seq = 0;
function event(over = {}) {
  seq += 1;
  const actorId = over.actorId || A1;
  return {
    id: `ntf_${actorId.slice(6)}_${seq}`,
    kind: "actor.awaiting_input",
    scope: "user",
    read: false,
    resolved: false,
    createdAt: new Date(Date.UTC(2026, 10, 21, 10, 0, seq)).toISOString(),
    message: "EU or US first?",
    actorId,
    actorTitle: "Launch plan",
    web: false,
    ...over,
  };
}

const goal = (over = {}) => ({ id: A1, title: "Launch plan", state: "awaiting_input", parkedBy: "", ...over });

const page = (notifications = [], actors = [], over = {}) => ({
  origin: ORIGIN,
  signedIn: true,
  notifications: { ok: true, status: 200, items: notifications },
  actors: { ok: true, status: 200, items: actors },
  ...over,
});

/* ---- A host with a clock that only moves when told to ---------------------------- */

function harness({ stored = null, answer = () => page(), watching = false } = {}) {
  const h = {
    now: 1_000_000,
    timers: [],
    notes: [],
    attention: [],
    saved: stored,
    reads: 0,
    answer,
    watching,
  };
  let nextHandle = 1;
  const host = {
    readPage: async () => {
      h.reads += 1;
      return h.answer();
    },
    notify: (note) => h.notes.push(note),
    setAttention: (view) => h.attention.push(view),
    isWatching: () => h.watching,
    load: () => h.saved,
    save: (state) => {
      h.saved = JSON.parse(JSON.stringify(state));
    },
    now: () => h.now,
    setTimer: (fn, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      h.timers.push({ handle, at: h.now + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      h.timers = h.timers.filter((timer) => timer.handle !== handle);
    },
  };
  h.watch = watchLib.createGoalWatch(host, { origin: ORIGIN });
  /** Milliseconds until the one pending timer, or null when nothing is scheduled. */
  h.due = () => (h.timers.length ? Math.min(...h.timers.map((timer) => timer.at)) - h.now : null);
  /** Move the clock, run what came due, and let each read finish. */
  h.advance = async (ms) => {
    const until = h.now + ms;
    for (;;) {
      const next = h.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      h.timers = h.timers.filter((timer) => timer !== next);
      h.now = next.at;
      next.fn();
      await h.watch.idle();
    }
    h.now = until;
  };
  return h;
}

/* ---- Announcing ------------------------------------------------------------------ */

test("a new event becomes one notification: fixed title, the goal's title and the message as the body", async () => {
  const first = event();
  const h = harness({ answer: () => page([first], [goal()]) });
  const result = await h.watch.tick();
  assert.equal(result.outcome, "ok");
  assert.equal(h.notes.length, 1);
  assert.deepEqual(h.notes[0], {
    title: "A goal has a question for you",
    body: "Launch plan\nEU or US first?",
    target: { view: "goal", goalId: A1 },
  });
});

test("the same event id is never announced twice — in this run or the next", async () => {
  const first = event();
  const h = harness({ answer: () => page([first], [goal()]) });
  await h.watch.tick();
  await h.watch.tick();
  await h.watch.tick();
  assert.equal(h.notes.length, 1);

  // A restart: a new watcher over what the first one saved.
  const again = harness({ stored: h.saved, answer: () => page([first], [goal()]) });
  await again.watch.tick();
  assert.equal(again.notes.length, 0);
});

test("each kind has this app's own title", async () => {
  const kinds = [
    ["actor.awaiting_input", "A goal has a question for you"],
    ["actor.done", "A goal is finished"],
    ["actor.blocked", "A goal is stuck"],
    ["actor.budget_cap", "A goal ran out of budget"],
    ["actor.failed", "A goal failed"],
  ];
  for (const [kind, title] of kinds) {
    const h = harness({ answer: () => page([event({ kind })], []) });
    await h.watch.tick();
    assert.equal(h.notes.length, 1, kind);
    assert.equal(h.notes[0].title, title);
  }
});

test("the runtime's codes are said in words, and an unknown code is not shown at all", async () => {
  const body = async (kind, message) => {
    const h = harness({ answer: () => page([event({ kind, message })], []) });
    await h.watch.tick();
    return h.notes[0].body;
  };
  assert.equal(await body("actor.budget_cap", "usd_cap"), "Launch plan\nIt used all the money it was given.");
  assert.equal(await body("actor.budget_cap", "mystery_cap"), "Launch plan");
  assert.equal(await body("actor.blocked", "agent: I need the staging password"), "Launch plan\nI need the staging password");
  assert.equal(await body("actor.blocked", "creator_revoked"), "Launch plan\nThe person who started it no longer has access.");
  assert.equal(await body("actor.failed", "cycle_error:TypeError"), "Launch plan\nIt stopped after repeated errors.");
});

test("a goal that reads the open web is labelled as one", async () => {
  const h = harness({ answer: () => page([event({ web: true })], [goal()]) });
  await h.watch.tick();
  assert.match(h.notes[0].body, /reads the open web/);
});

test("more than three new events at once collapse into one summary, in the app's words only", async () => {
  const burst = [event({ actorId: A1 }), event({ actorId: A2 }), event({ actorId: A3, kind: "actor.blocked" }), event({ actorId: A3, kind: "actor.budget_cap" })];
  const h = harness({ answer: () => page(burst, []) });
  const result = await h.watch.tick();
  assert.equal(result.shown, 1);
  assert.equal(h.notes.length, 1);
  assert.deepEqual(h.notes[0], { title: "3 goals need you", body: "2 questions · 1 stuck · 1 out of budget", target: { view: "list" } });
  // Every one of them is remembered, so the next read says nothing.
  await h.watch.tick();
  assert.equal(h.notes.length, 1);
  assert.equal(h.saved.announced.length, 4);
});

test("a burst that is not all waiting on the person is not called \"need you\"", async () => {
  const burst = [event({ actorId: A1, kind: "actor.done" }), event({ actorId: A2, kind: "actor.done" }), event({ actorId: A3 }), event({ actorId: A3, kind: "actor.failed" })];
  const h = harness({ answer: () => page(burst, []) });
  await h.watch.tick();
  assert.deepEqual(h.notes.map((note) => note.title), ["3 goals have news"]);
  assert.equal(h.notes[0].body, "1 question · 2 finished · 1 failed");
});

test("exactly three new events are still three notifications, oldest first", async () => {
  const three = [event({ message: "one" }), event({ message: "two" }), event({ message: "three" })];
  // The runtime lists newest first.
  const h = harness({ answer: () => page(three.slice().reverse(), []) });
  await h.watch.tick();
  assert.deepEqual(h.notes.map((note) => note.body.split("\n")[1]), ["one", "two", "three"]);
});

test("a resolved question and an event its goal has moved on from are remembered, not announced", async () => {
  const answered = event({ resolved: true });
  const stale = event({ actorId: A2 }); // asked — but the goal is working again
  const finished = event({ actorId: A2, kind: "actor.done" }); // a finish is news whatever the state is now
  const h = harness({ answer: () => page([answered, stale, finished], [goal({ id: A2, state: "active" })]) });
  await h.watch.tick();
  assert.deepEqual(h.notes.map((note) => note.title), ["A goal is finished"]);
  assert.equal(h.saved.announced.length, 3);
});

test("with the app in front of the person nothing is shown, and it is not shown later either", async () => {
  const first = event();
  const h = harness({ answer: () => page([first], [goal()]), watching: true });
  await h.watch.tick();
  assert.equal(h.notes.length, 0);
  h.watching = false;
  await h.watch.tick();
  assert.equal(h.notes.length, 0);
});

test("a notification that cannot be shown is not retried", async () => {
  const first = event();
  let attempts = 0;
  const host = {
    readPage: async () => page([first], [goal()]),
    notify: () => {
      attempts += 1;
      throw new Error("notifications are not allowed");
    },
    setAttention: () => undefined,
    load: () => null,
    save: () => undefined,
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => undefined,
  };
  const watch = watchLib.createGoalWatch(host, { origin: ORIGIN });
  assert.equal((await watch.tick()).outcome, "ok");
  assert.equal((await watch.tick()).outcome, "ok");
  assert.equal(attempts, 1);
});

/* ---- The count ------------------------------------------------------------------- */

test("the count is the goals that need the person: a question, or parked by the agent or the budget", async () => {
  const actors = [
    goal({ id: A1, state: "awaiting_input", title: "Asks" }),
    goal({ id: A2, state: "blocked", parkedBy: "agent", title: "Stuck" }),
    goal({ id: A3, state: "blocked", parkedBy: "budget", title: "Broke" }),
    goal({ id: "actor_1111111111111111", state: "blocked", parkedBy: "creator_revoked" }),
    goal({ id: "actor_2222222222222222", state: "blocked" }),
    goal({ id: "actor_3333333333333333", state: "active" }),
    goal({ id: "actor_4444444444444444", state: "done" }),
  ];
  const h = harness({ answer: () => page([], actors) });
  const result = await h.watch.tick();
  assert.equal(result.needs, 3);
  assert.deepEqual(h.attention.at(-1), {
    count: 3,
    goals: [
      { id: A1, title: "Asks", why: "question" },
      { id: A2, title: "Stuck", why: "stuck" },
      { id: A3, title: "Broke", why: "budget" },
    ],
  });
});

test("the count goes back to zero, and the host is only told when it changes", async () => {
  let actors = [goal()];
  const h = harness({ answer: () => page([], actors) });
  await h.watch.tick();
  await h.watch.tick();
  assert.equal(h.attention.length, 1);
  actors = [goal({ state: "active" })];
  await h.watch.tick();
  assert.deepEqual(h.attention.at(-1), { count: 0, goals: [] });
  assert.equal(h.attention.length, 2);
});

/* ---- What comes back is not trusted ---------------------------------------------- */

test("malformed rows are dropped: wrong id shapes, unknown kinds, another mailbox, wrong types", async () => {
  const good = event();
  const rows = [
    good,
    event({ id: "ntf_../../etc/passwd_1" }),
    event({ id: "ntf_3f9c1a2b4d5e6f70" }),
    event({ id: 42 }),
    event({ kind: "actor.exploded" }),
    event({ kind: "constructor" }),
    event({ actorId: "actor_XYZ" }),
    event({ actorId: "actor_3f9c1a2b4d5e6f70/../x" }),
    event({ scope: "org_admins" }),
    event({ read: true }),
    event({ read: "false" }),
    event({ message: { toString: () => "boom" } }),
    event({ web: "yes" }),
    null,
    "a string",
    [good],
  ];
  const actors = [goal(), goal({ id: "not-an-actor" }), goal({ id: A2, state: "levitating" }), goal({ id: A3, parkedBy: "gremlins", state: "blocked" }), 7];
  const h = harness({ answer: () => page(rows, actors) });
  const result = await h.watch.tick();
  assert.equal(result.outcome, "ok");
  assert.equal(h.notes.length, 1);
  assert.deepEqual(h.saved.announced, [good.id]);
  assert.equal(result.needs, 1);
});

test("oversized text is dropped rather than shown: the page clips, so longer was not the page", async () => {
  const rows = [event({ message: "x".repeat(watchLib.PAGE_MESSAGE_MAX + 1) }), event({ actorTitle: "y".repeat(121) })];
  const h = harness({ answer: () => page(rows, [goal({ title: "z".repeat(121) })]) });
  const result = await h.watch.tick();
  assert.equal(h.notes.length, 0);
  assert.equal(result.needs, 0);
});

test("lists longer than the runtime's ceiling are cut, not walked", async () => {
  const many = Array.from({ length: 450 }, (_, i) => event({ resolved: true, id: `ntf_3f9c1a2b4d5e6f70_${i + 1000}` }));
  const h = harness({ answer: () => page(many, []) });
  await h.watch.tick();
  assert.equal(h.saved.announced.length, 200);
});

test("an answer of the wrong shape, or from another origin, is thrown away whole and counts as a failure", async () => {
  for (const answer of [42, "nope", [], {}, { signedIn: "yes" }, page([event()], [goal()], { origin: "https://evil.example" }), page([event()], [goal()], { origin: undefined })]) {
    const h = harness({ answer: () => answer });
    const result = await h.watch.tick();
    assert.equal(result.outcome, "failed");
    assert.equal(result.error, "bad_shape");
    assert.equal(h.notes.length, 0);
    assert.equal(h.attention.length, 0);
  }
});

test("text is shown as one plain line: no control characters, no bidi tricks, clipped", async () => {
  assert.equal(watchLib.plain("a\u202eb\nc\u0007\u200bd", 40), "a b c d");
  assert.equal(watchLib.plain("  spaced \t out  ", 40), "spaced out");
  assert.equal(watchLib.plain("abcdefghij", 5), "abcd…");
  assert.equal(watchLib.plain(null, 5), "");
  const h = harness({ answer: () => page([event({ message: `line one\r\nline two ${"z".repeat(270)}`, actorTitle: "" })], []) });
  await h.watch.tick();
  const [title, message] = h.notes[0].body.split("\n");
  assert.equal(title, "Untitled goal");
  assert.equal(h.notes[0].body.split("\n").length, 2);
  assert.ok(message.startsWith("line one line two"));
  assert.ok(Array.from(message).length <= 240);
});

test("a click may name a goal only by a well-formed id; anything else opens the list", () => {
  assert.deepEqual(watchLib.cleanTarget({ view: "goal", goalId: A1 }), { view: "goal", goalId: A1 });
  assert.deepEqual(watchLib.cleanTarget({ view: "new" }), { view: "new" });
  for (const bad of [null, undefined, "goal", {}, { view: "goal" }, { view: "goal", goalId: "actor_1" }, { view: "goal", goalId: `${A1}?x=1` }, { view: "goal", goalId: "https://evil.example" }, { view: "url", url: "https://evil.example" }]) {
    assert.deepEqual(watchLib.cleanTarget(bad), { view: "list" });
  }
  // And nothing rides along with a good one.
  assert.deepEqual(watchLib.cleanTarget({ view: "goal", goalId: A1, url: "https://evil.example" }), { view: "goal", goalId: A1 });
});

/* ---- When it does nothing --------------------------------------------------------- */

test("signed out: nothing is announced, the count clears, and it looks again rarely", async () => {
  let answer = page([], [goal()]);
  const h = harness({ answer: () => answer });
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  assert.equal(h.attention.at(-1).count, 1);
  answer = { origin: ORIGIN, signedIn: false };
  await h.advance(watchLib.POLL_MS);
  assert.equal(h.notes.length, 0);
  assert.deepEqual(h.attention.at(-1), { count: 0, goals: [] });
  assert.equal(h.due(), watchLib.SIGNED_OUT_MS);
});

test("a refused key (401/403) is treated as signed out, not hammered", async () => {
  const h = harness({
    answer: () => page([], [], { notifications: { ok: false, status: 401, items: [] }, actors: { ok: false, status: 401, items: [] } }),
  });
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  assert.equal(h.due(), watchLib.SIGNED_OUT_MS);
});

test("signing in is noticed without waiting out the pause", async () => {
  let answer = { origin: ORIGIN, signedIn: false };
  const h = harness({ answer: () => answer });
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  assert.equal(h.due(), watchLib.SIGNED_OUT_MS);
  answer = page([event()], [goal()]);
  await h.advance(60_000);
  h.watch.pageMoved(); // the page moved on from the sign-in screen
  assert.equal(h.due(), watchLib.POKE_MS);
  await h.advance(watchLib.POKE_MS);
  assert.equal(h.notes.length, 1);
  // …and once signed in, moving between threads does not ask for more reads.
  const before = h.due();
  h.watch.pageMoved();
  assert.equal(h.due(), before);
});

test("no trusted page to ask (another origin, still loading): the read is skipped and nothing changes", async () => {
  const first = event();
  let answer = page([first], [goal()]);
  const h = harness({ answer: () => answer });
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  assert.equal(h.notes.length, 1);
  answer = null;
  await h.advance(watchLib.POLL_MS);
  assert.equal(h.notes.length, 1);
  assert.equal(h.attention.length, 1); // the count it had is left alone
  assert.equal(h.due(), watchLib.POLL_MS);
});

test("with the setting off nothing is read, nothing is scheduled, and the count is cleared", async () => {
  const h = harness({ stored: { notify: false, announced: [] }, answer: () => page([event()], [goal()]) });
  h.watch.start();
  assert.equal(h.due(), null);
  await h.advance(10 * 60_000);
  h.watch.poke();
  h.watch.pageLoaded();
  assert.equal((await h.watch.tick()).outcome, "off");
  assert.equal(h.reads, 0);
  assert.equal(h.notes.length, 0);

  // Turned on: it starts. Turned off again: it stops, and what it showed is taken back.
  h.watch.setEnabled(true);
  assert.equal(h.saved.notify, true);
  await h.advance(watchLib.POKE_MS);
  assert.equal(h.reads, 1);
  assert.equal(h.attention.at(-1).count, 1);
  h.watch.setEnabled(false);
  assert.equal(h.saved.notify, false);
  assert.deepEqual(h.attention.at(-1), { count: 0, goals: [] });
  assert.equal(h.due(), null);
  await h.advance(10 * 60_000);
  assert.equal(h.reads, 1);
});

test("switched off while a read is in flight: the answer counts for nothing", async () => {
  let release;
  const h = harness({ answer: () => new Promise((resolve) => (release = resolve)) });
  h.watch.start();
  const running = h.watch.tick();
  await Promise.resolve();
  h.watch.setEnabled(false);
  release(page([event()], [goal()]));
  assert.equal((await running).outcome, "off");
  assert.equal(h.notes.length, 0);
  assert.equal(h.attention.length, 0);
  assert.equal(h.due(), null);
});

/* ---- Pacing ------------------------------------------------------------------------ */

test("it reads about every 45 seconds while all is well", async () => {
  const h = harness();
  h.watch.start();
  assert.equal(h.due(), watchLib.FIRST_POLL_MS);
  await h.advance(watchLib.FIRST_POLL_MS);
  assert.equal(h.reads, 1);
  assert.equal(h.due(), 45_000);
  await h.advance(45_000 * 4);
  assert.equal(h.reads, 5);
});

test("failures back off — doubling, to a ceiling — and one good read restores the pace", async () => {
  let fail = true;
  const failing = page([], [], { notifications: { ok: false, status: 502, items: [] }, actors: { ok: false, status: 502, items: [] } });
  const h = harness({ answer: () => (fail ? failing : page()) });
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  const waits = [];
  for (let i = 0; i < 7; i += 1) {
    waits.push(h.due());
    await h.advance(h.due());
  }
  assert.deepEqual(waits, [90_000, 180_000, 360_000, 720_000, 900_000, 900_000, 900_000]);
  fail = false;
  await h.advance(h.due());
  assert.equal(h.due(), watchLib.POLL_MS);
});

test("a page read that throws or times out is a failure like any other, and never a crash", async () => {
  let mode = "throw";
  const h = harness({
    answer: () => {
      if (mode === "ok") return page();
      const error = new Error("boom");
      if (mode === "timeout") error.name = "TimeoutError";
      throw error;
    },
  });
  assert.deepEqual(await h.watch.tick(), { outcome: "failed", error: "page_error" });
  mode = "timeout";
  assert.deepEqual(await h.watch.tick(), { outcome: "failed", error: "timeout" });
  mode = "ok";
  assert.equal((await h.watch.tick()).outcome, "ok");
});

test("one list failing does not hide the other, and still slows the pace", async () => {
  const first = event();
  const h = harness({ answer: () => page([first], [], { actors: { ok: false, status: 500, items: [] } }) });
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  assert.equal(h.notes.length, 1);
  assert.equal(h.attention.length, 0);
  assert.equal(h.due(), 90_000);
});

test("a poke brings the next read forward, but never on top of the last one and never twice", async () => {
  const h = harness();
  h.watch.start();
  await h.advance(watchLib.FIRST_POLL_MS);
  h.watch.poke(); // right after a read: held to the minimum gap
  assert.equal(h.due(), watchLib.MIN_GAP_MS);
  h.watch.poke();
  h.watch.poke();
  assert.equal(h.timers.length, 1);
  await h.advance(watchLib.MIN_GAP_MS);
  assert.equal(h.reads, 2);
  await h.advance(30_000);
  h.watch.poke();
  assert.equal(h.due(), watchLib.POKE_MS);
});

test("two reads never overlap", async () => {
  let release;
  const h = harness({ answer: () => new Promise((resolve) => (release = resolve)) });
  const first = h.watch.tick();
  assert.equal((await h.watch.tick()).outcome, "busy");
  assert.equal(h.reads, 1);
  release(page());
  assert.equal((await first).outcome, "ok");
});

test("stop cancels what was scheduled", async () => {
  const h = harness();
  h.watch.start();
  h.watch.stop();
  assert.equal(h.due(), null);
  await h.advance(10 * 60_000);
  assert.equal(h.reads, 0);
});

/* ---- The store ---------------------------------------------------------------------- */

test("announced ids are bounded to the newest 300 and survive a reload from disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-goal-watch-"));
  const file = path.join(dir, "nested", "goal-watch.json");
  const store = watchLib.fileStore(file);
  const open = (answer) => {
    const h = harness({ answer });
    const host = { ...hostOf(h), load: store.load, save: store.save };
    return { h, watch: watchLib.createGoalWatch(host, { origin: ORIGIN }) };
  };
  // 4 reads of 100 new ids each: 400 seen, 300 kept.
  let batch = 0;
  const rows = () => Array.from({ length: 100 }, (_, i) => event({ resolved: true, id: `ntf_3f9c1a2b4d5e6f70_${batch * 100 + i}` }));
  const first = open(() => page(rows(), []));
  for (batch = 0; batch < 4; batch += 1) await first.watch.tick();
  const kept = first.watch.announced();
  assert.equal(kept.length, watchLib.ANNOUNCED_KEEP);
  assert.equal(kept[0], "ntf_3f9c1a2b4d5e6f70_100");
  assert.equal(kept.at(-1), "ntf_3f9c1a2b4d5e6f70_399");

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.announced.length, 300);
  assert.equal(onDisk.notify, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // A new watcher over the same file knows them all: the newest id again is not news.
  const newest = event({ id: "ntf_3f9c1a2b4d5e6f70_399" });
  const second = open(() => page([newest], [goal()]));
  assert.deepEqual(second.watch.announced(), kept);
  await second.watch.tick();
  assert.equal(second.h.notes.length, 0);

  // The switch is in the same file.
  second.watch.setEnabled(false);
  assert.equal(open(() => page()).watch.isEnabled(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The harness's host again, for a test that swaps one part of it. */
function hostOf(h) {
  return {
    readPage: async () => {
      h.reads += 1;
      return h.answer();
    },
    notify: (note) => h.notes.push(note),
    setAttention: (view) => h.attention.push(view),
    now: () => h.now,
    setTimer: () => 1,
    clearTimer: () => undefined,
  };
}

test("a store file that is missing, unreadable or hand-edited into nonsense reads as the defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-goal-watch-"));
  const file = path.join(dir, "goal-watch.json");
  assert.equal(watchLib.fileStore(file).load(), null);
  fs.writeFileSync(file, "{ not json");
  assert.equal(watchLib.fileStore(file).load(), null);
  assert.deepEqual(watchLib.cleanState(null), { notify: true, announced: [] });
  assert.deepEqual(watchLib.cleanState({ notify: "no", announced: "ntf_3f9c1a2b4d5e6f70_1" }), { notify: true, announced: [] });
  assert.deepEqual(
    watchLib.cleanState({ notify: false, announced: ["ntf_3f9c1a2b4d5e6f70_1", "../../x", 7, null, "ntf_3f9c1a2b4d5e6f70_1", "ntf_3f9c1a2b4d5e6f70_2"], apiKey: "nope" }),
    { notify: false, announced: ["ntf_3f9c1a2b4d5e6f70_1", "ntf_3f9c1a2b4d5e6f70_2"] },
  );
  const long = Array.from({ length: 1000 }, (_, i) => `ntf_3f9c1a2b4d5e6f70_${i}`);
  const cleaned = watchLib.cleanState({ announced: long });
  assert.equal(cleaned.announced.length, 300);
  assert.equal(cleaned.announced.at(-1), "ntf_3f9c1a2b4d5e6f70_999");
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---- The functions that run in the page ---------------------------------------------- */

const SECRET = "nx_live_THIS-IS-THE-KEY";

/** A stand-in for the page: its storage, its origin, and a fetch that records what it was asked. */
function fakePage({ session, routes = {} } = {}) {
  const calls = [];
  const sandbox = {
    window: {
      location: { origin: ORIGIN },
      localStorage: { getItem: (name) => (name === "nexora.session" ? session ?? null : null) },
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const route = routes[String(url).split("?")[0]];
      if (!route) return { ok: false, status: 404, json: async () => ({}) };
      if (route.throws) throw new Error("network");
      return { ok: route.status ? route.status < 400 : true, status: route.status || 200, json: async () => route.body };
    },
    AbortController,
    setTimeout,
    clearTimeout,
  };
  return { calls, run: (source) => vm.runInNewContext(source, sandbox) };
}

const signedIn = JSON.stringify({ state: { apiKey: SECRET, principal: { id: "op-a", name: "A" } }, version: 0 });

test("the page read never hands the key back, and sends it only to the page's own proxy", async () => {
  const serverRow = {
    id: "ntf_3f9c1a2b4d5e6f70_7",
    kind: "actor.awaiting_input",
    title: "Actor is waiting for your answer",
    message: "EU or US first?",
    severity: "warning",
    read: false,
    createdAt: "2026-11-21T10:01:40.000Z",
    scope: "user",
    metadata: { actorId: A1, actorTitle: "Launch plan", conversationId: "chat_81d0c3f2a4b5e6f7", createdBy: "op-a", state: "awaiting_input", capabilities: ["web"], ask: { id: "ask_1", question: "EU or US first?" } },
  };
  const fake = fakePage({
    session: signedIn,
    routes: {
      "/api/nx/api/v1/notifications": { body: { notifications: [serverRow] } },
      "/api/nx/api/v1/actors": { body: { actors: [{ id: A1, title: "", intent: "Plan the launch", state: "awaiting_input", createdBy: "op-a", conversationId: "chat_81d0c3f2a4b5e6f7" }] } },
    },
  });
  const result = await fake.run(watchLib.PAGE_READ_JS);

  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(Object.keys(result).sort(), ["actors", "notifications", "origin", "signedIn"]);
  assert.deepEqual(fake.calls.map((call) => call.url).sort(), ["/api/nx/api/v1/actors?mine=true&limit=100", "/api/nx/api/v1/notifications?scope=user&unread=true"]);
  for (const call of fake.calls) {
    assert.ok(call.url.startsWith("/api/nx/"), "a relative, same-origin address");
    assert.deepEqual({ ...call.init.headers }, { "x-api-key": SECRET });
    assert.equal(call.init.method, undefined); // a GET: the watcher only reads
    assert.equal(call.init.body, undefined);
  }
  // Only the fields the watcher uses come back — and they pass its own checks.
  assert.deepEqual(Object.keys(result.notifications.items[0]).sort(), ["actorId", "actorTitle", "createdAt", "id", "kind", "message", "read", "resolved", "scope", "web"]);
  assert.deepEqual(Object.keys(result.actors.items[0]).sort(), ["id", "parkedBy", "state", "title"]);
  const checked = watchLib.validateRead(JSON.parse(JSON.stringify(result)), ORIGIN);
  assert.equal(checked.notifications.length, 1);
  assert.equal(checked.notifications[0].web, true);
  assert.deepEqual(checked.actors, [{ id: A1, state: "awaiting_input", parkedBy: "", title: "Plan the launch" }]);
});

test("the page read makes no request at all when nobody is signed in", async () => {
  for (const session of [null, "", "{ not json", JSON.stringify({ state: { apiKey: "" } }), JSON.stringify({ state: { apiKey: 42 } }), JSON.stringify({ state: null }), "null", "[]"]) {
    const fake = fakePage({ session });
    const result = await fake.run(watchLib.PAGE_READ_JS);
    assert.deepEqual({ ...result }, { origin: ORIGIN, signedIn: false });
    assert.equal(fake.calls.length, 0);
  }
});

test("the page read clips what it returns and survives a hostile or broken answer", async () => {
  const huge = "A".repeat(50_000);
  const fake = fakePage({
    session: signedIn,
    routes: {
      "/api/nx/api/v1/notifications": {
        body: {
          notifications: [
            { id: huge, kind: huge, scope: huge, read: "yes", createdAt: huge, message: huge, metadata: { actorId: huge, actorTitle: huge, capabilities: "web" } },
            null,
            7,
            ...Array.from({ length: 500 }, () => ({})),
          ],
        },
      },
      "/api/nx/api/v1/actors": { body: { actors: "not a list" } },
    },
  });
  const result = JSON.parse(JSON.stringify(await fake.run(watchLib.PAGE_READ_JS)));
  assert.equal(result.notifications.items.length, 200);
  const row = result.notifications.items[0];
  assert.deepEqual([row.id.length, row.kind.length, row.message.length, row.actorTitle.length, row.actorId.length], [80, 40, 300, 120, 60]);
  assert.equal(row.web, false);
  assert.ok(JSON.stringify(row).length < 1_000, "a 350 KB row comes back as under 1 KB");
  assert.deepEqual(result.actors, { ok: false, status: 200, items: [] });
  // Nothing in it passes the watcher's checks.
  assert.deepEqual(watchLib.validateRead(result, ORIGIN).notifications, []);
});

test("the page read reports a refused or failed request as a status, not an exception", async () => {
  const refused = fakePage({ session: signedIn, routes: { "/api/nx/api/v1/notifications": { status: 401, body: { error: "unauthorized" } }, "/api/nx/api/v1/actors": { throws: true } } });
  const result = JSON.parse(JSON.stringify(await refused.run(watchLib.PAGE_READ_JS)));
  assert.deepEqual(result.notifications, { ok: false, status: 401, items: [] });
  assert.deepEqual(result.actors, { ok: false, status: 0, items: [] });
  assert.equal(watchLib.validateRead(result, ORIGIN).denied, true);
});

test("the two page functions are fixed text: nothing is spliced into them", () => {
  for (const source of [watchLib.PAGE_READ_JS, watchLib.PAGE_PRESS_GOALS_JS]) {
    assert.equal(typeof source, "string");
    assert.equal(source.includes("${"), false);
    assert.equal(source.includes("actor_"), false);
    assert.equal(source.includes("ntf_"), false);
  }
  // The same text every time it is asked for.
  delete require.cache[require.resolve("../goal-watch")];
  const again = require("../goal-watch");
  assert.equal(again.PAGE_READ_JS, watchLib.PAGE_READ_JS);
  assert.equal(again.PAGE_PRESS_GOALS_JS, watchLib.PAGE_PRESS_GOALS_JS);
});

test("pressing the Goals button: the page's own button, by its label, or nothing", () => {
  const press = (labels) => {
    let clicked = null;
    const buttons = labels.map((label) => ({ label, click: () => (clicked = label) }));
    const document = {
      querySelector: (selector) => {
        assert.equal(selector, 'button[aria-label="Goals"], button[aria-label^="Goals — "]');
        return buttons.find((button) => button.label === "Goals" || button.label.startsWith("Goals — ")) || null;
      },
    };
    const pressed = vm.runInNewContext(watchLib.PAGE_PRESS_GOALS_JS, { document });
    return { pressed, clicked };
  };
  assert.deepEqual(press(["Send", "Goals"]), { pressed: true, clicked: "Goals" });
  assert.deepEqual(press(["Goals — 2 need your attention"]), { pressed: true, clicked: "Goals — 2 need your attention" });
  assert.deepEqual(press(["Send", "Goalsetter"]), { pressed: false, clicked: null });
});

/* ---- The menu bar icon ---------------------------------------------------------------- */

test("the menu bar icon is a template image: black, alpha only, a ring with a centre", () => {
  for (const size of [18, 36]) {
    const pixels = watchLib.iconBitmap(size);
    assert.equal(pixels.length, size * size * 4);
    const alpha = (x, y) => pixels[(y * size + x) * 4 + 3];
    for (let i = 0; i < pixels.length; i += 4) assert.equal(pixels[i] + pixels[i + 1] + pixels[i + 2], 0);
    const mid = Math.floor(size / 2);
    assert.equal(alpha(mid, mid), 255, "the centre is filled");
    assert.equal(alpha(0, 0), 0, "the corner is clear");
    assert.equal(alpha(mid, Math.round(size * 0.27)), 0, "a gap between the centre and the ring");
    assert.equal(alpha(mid, Math.round(size * 0.1)), 255, "the ring");
  }
});
