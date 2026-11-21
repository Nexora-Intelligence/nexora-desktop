const guard = require("./command-guard");

/**
 * Nexora Desktop — the permission gate.
 *
 * Every local action asks before it runs. "Always Allow (this session)" used to
 * be remembered per capability, so one click on a harmless `git status` let
 * every later shell command through unasked. It is now remembered under the
 * key the request carries — `shell:git status` for that command, `write` for
 * writes and edits, `move` for moves — and a request can say it may never be
 * covered: a command line that chains, pipes, redirects or substitutes, an
 * interpreter or anything else that runs what it is handed, input to a running
 * process, a write that replaces a file this session did not write, a shell
 * start-up or credentials file, and a delete. Those ask every time, Allow or
 * Deny, and the dialog says why. These are Nexora Code's rules (`makeGate` in
 * the extension's `localExec.ts`); the words they are worded in come from
 * `command-guard.js`.
 *
 * Nothing here imports Electron, so the rule is tested without a window: the
 * host supplies `ask`, which shows the request and answers "allow", "session"
 * or "deny". A dismissed dialog is a denial.
 *
 * A request is `(capability, detail, request)`:
 *   capability   what is being asked for — picks the dialog's wording
 *   detail       what exactly, as text
 *   request.key          what a grant is remembered under (default: the capability)
 *   request.sessionable  false when no grant may cover it (default: true, except delete)
 *   request.note         why it asks every time, as one sentence
 *   request.covers       what "Always Allow" would cover, in words
 *   request.guarded      a start-up or credentials file: the dialog warns and defaults to Deny
 * Callers that pass only `(capability, detail)` — the browser, computer use,
 * the agent CLIs — keep a per-capability grant, as before.
 */

const DETAIL_LIMIT = 800;
const DETAIL_HEAD = 520;
const DETAIL_TAIL = 200;

const INVISIBLE = new RegExp(guard.UNUSUAL_CHARS.source, "gu");

/**
 * Invisible and look-alike-blank characters written out as escapes — a
 * direction override in a command line is shown as `\u{202E}` rather than
 * rendered, so the dialog reads as what will run.
 */
function visibleEscapes(text) {
  return String(text ?? "").replace(INVISIBLE, (ch) => `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`);
}

/**
 * The text a dialog shows: escapes made visible, and a body too long for the
 * dialog cut in the middle with the count of what is missing — never silently
 * at the end, where the part of a command that matters most can hide. The
 * closing lines (why it asks every time, what a grant would cover) are kept
 * whole whatever the body's length.
 */
function dialogDetail(detail, request = {}) {
  let body = visibleEscapes(detail);
  if (body.length > DETAIL_LIMIT) {
    const hidden = body.length - DETAIL_HEAD - DETAIL_TAIL;
    body = `${body.slice(0, DETAIL_HEAD)}\n[… ${hidden.toLocaleString("en-US")} characters not shown …]\n${body.slice(-DETAIL_TAIL)}`;
  }
  const closing = [];
  if (request.note) closing.push(visibleEscapes(request.note));
  if (isSessionable("", request) && request.covers) {
    closing.push(`“Always Allow” covers ${visibleEscapes(request.covers)} until you quit or reset local permissions.`);
  }
  return closing.length ? `${body}\n\n${closing.join("\n")}` : body;
}

function isSessionable(capability, request = {}) {
  return capability !== "delete" && request.sessionable !== false;
}

/**
 * The gate. `ask({ capability, detail, sessionable, guarded, key, note })`
 * answers "allow", "session" or "deny"; anything else is a denial.
 */
function createGate({ ask }) {
  const grants = new Map(); // key -> { at, detail }

  async function confirm(capability, detail, request = {}) {
    const key = String(request.key || capability);
    const sessionable = isSessionable(capability, request);
    if (sessionable && grants.has(key)) return true;
    const answer = await ask({
      capability,
      key,
      sessionable,
      guarded: Boolean(request.guarded),
      note: request.note,
      detail: dialogDetail(detail, { ...request, sessionable }),
    });
    if (answer === "session" && sessionable) {
      grants.set(key, { at: Date.now(), detail: String(detail ?? "").split("\n")[0].slice(0, 200) });
      return true;
    }
    // "session" on a request that may not be covered is one allow, nothing remembered.
    return answer === "allow" || answer === "session";
  }

  return {
    confirm,
    has: (key) => grants.has(key),
    list: () => [...grants.entries()].map(([key, value]) => ({ key, ...value })),
    clear: () => grants.clear(),
  };
}

module.exports = { createGate, dialogDetail, visibleEscapes };
