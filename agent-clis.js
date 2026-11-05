const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const local = require("./local-tools");

/**
 * Nexora Desktop — Agent CLIs.
 *
 * agent-desktop (computer use through the OS accessibility tree) and
 * agent-browser (a headless Chrome for Testing driven over CDP) are Vercel
 * Labs command-line tools built for exactly the loop our model runs: snapshot,
 * act on a ref, observe again. They are tools, not agents, so the integration
 * is one tool per CLI that mirrors the command line — the model loads the guide
 * the binary carries (`skills get desktop`, `skills get core`) and composes
 * commands — and this module is the part that keeps that honest:
 *
 *   - a refuse list for the commands that would hang the call (servers), do
 *     setup the host owns (install, upgrade), or hand the model the person's
 *     vault (auth, profiles, confirm, deny);
 *   - argument checks, and stdin for text that must not show up in `ps`;
 *   - the same permission dialog and audit line as every other local tool;
 *   - a timeout, an output cap, and a screenshot turned into an image block.
 *
 * The binaries ship inside the app (the npm packages, unpacked from the asar),
 * and a copy the person installed themselves is honoured first when they point
 * at it, because a CLI that is already on their machine is the one their
 * terminal workflows and this app should agree on.
 */

const MAX_OUTPUT = 100_000; // chars of stdout handed back to the model
const STDERR_TAIL = 2_000;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4_096;
const MAX_STDIN_CHARS = 65_536;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const PLATFORM_SUFFIX = `${process.platform}-${process.arch}`;

const CLIS = {
  desktop: {
    id: "desktop",
    name: "agent-desktop",
    package: "agent-desktop",
    capability: "agentDesktop",
    envVar: "NEXORA_AGENT_DESKTOP_BIN",
    // Inside the npm package: the postinstall copy, then the per-platform file.
    bundled: ["bin/agent-desktop", `bin/agent-desktop-${PLATFORM_SUFFIX}`],
    onPath: ["agent-desktop"],
    install: "npm install -g agent-desktop  (or: brew install agent-desktop)",
    guide: "skills get desktop",
    refused: {
      mcp: "it starts an MCP server and never returns",
      batch: "it runs a list of commands under one approval and the per-command checks would not see them; run them one per call",
      "key-down": "the CLI refuses it without a daemon to release the key",
      "key-up": "the CLI refuses it without a daemon to release the key",
      "mouse-down": "the CLI refuses it without a daemon to release the button",
      "mouse-up": "the CLI refuses it without a daemon to release the button",
    },
    // Debug artifacts are HTML renderings of the screen written to any path;
    // the model has no use for them and the person would not see them.
    refusedFlags: { "--trace": "it writes a trace file to a path of the model's choosing", "--trace-strict": "it writes a trace file to a path of the model's choosing", "--screenshot": "it writes a screen visualisation to a path of the model's choosing", "--debug": "it writes a screen visualisation to a path of the model's choosing" },
    refusedArgPrefixes: {},
    pathArgsConfined: new Set(),
    stdinCommands: new Set(["type", "set-value", "clipboard-set"]),
  },
  browser: {
    id: "browser",
    name: "agent-browser",
    package: "agent-browser",
    capability: "agentBrowser",
    envVar: "NEXORA_AGENT_BROWSER_BIN",
    bundled: [`bin/agent-browser-${PLATFORM_SUFFIX}`],
    onPath: [`agent-browser-${PLATFORM_SUFFIX}`, "agent-browser"],
    install: "npm install -g agent-browser && agent-browser install  (or: brew install agent-browser && agent-browser install)",
    guide: "skills get core",
    refused: {
      mcp: "it starts an MCP server and never returns",
      dashboard: "it starts a web server and never returns",
      stream: "it starts a streaming server and never returns",
      chat: "it is an interactive session, not a command",
      plugin: "it installs code into the CLI; the user does that themselves",
      install: "setup is done by the user (Agent → Agent CLIs → Install Browser…)",
      upgrade: "setup is done by the user",
      auth: "the auth vault belongs to the user, not the model",
      profiles: "the auth vault belongs to the user, not the model",
      confirm: "approvals are the user's to give",
      deny: "approvals are the user's to give",
      batch: "it runs a list of commands under one approval and the per-command checks would not see them; run them one per call",
      flow: "it replays a recorded command list the per-command checks would not see; run the steps one per call",
    },
    // Flags that would point the headless browser at the person's real Chrome
    // (sessions and all), run a binary of the model's choosing, or load code.
    refusedFlags: {
      "--cdp": "it attaches to a running Chrome — the user's own browser and sessions",
      "--auto-connect": "it attaches to a running Chrome — the user's own browser and sessions",
      "--user-data-dir": "it opens a browser profile folder of the model's choosing",
      "--profile": "it opens a browser profile of the model's choosing",
      "--executable-path": "it runs a binary of the model's choosing",
      "--browser-path": "it runs a binary of the model's choosing",
      "--extension": "it loads code into the browser",
      "--extensions": "it loads code into the browser",
      "--load-extension": "it loads code into the browser",
      "--init-script": "it injects a script file of the model's choosing into every page",
    },
    // URL schemes that read this machine instead of the web.
    refusedArgPrefixes: { "file:": "the browser would read local files", "chrome:": "browser internals", "chrome-extension:": "browser internals", "javascript:": "use eval instead", "view-source:": "use get html instead" },
    // A local file handed to a web page is a read of that file: it stays
    // inside the workspace folders the local tools are confined to.
    pathArgsConfined: new Set(["upload"]),
    // agent-browser takes text as an argument (`fill @e2 "text"`); it has no
    // --stdin, so stdin is never attached to it.
    stdinCommands: new Set(),
  },
};

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Tool definitions — the contract shared with Nexora Code and the web chat
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The subcommand, e.g. snapshot, click, type, set-value, press, find, get, list-apps, launch, screenshot, skills, status",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: 'Arguments and flags exactly as on the command line, one item each, e.g. ["--app","Finder","-i","--compact"]',
    },
    stdin: {
      type: "string",
      description: "Text to pipe on stdin. For agent-desktop's type, set-value and clipboard-set, --stdin is added so the text never appears in process arguments; agent-browser takes text as an argument and reads batch commands from stdin.",
    },
    timeoutMs: { type: "integer", description: "Kill the command after this long. Default 60000, max 300000." },
  },
  required: ["command"],
};

const TOOL_DEFS = [
  {
    name: "agent_desktop",
    cli: "desktop",
    description:
      "Computer use through the OS accessibility tree (the agent-desktop CLI): see and operate the desktop apps on this machine without screenshots. " +
      "One command per call; the result is the CLI's JSON envelope. Once per conversation run `skills get desktop` (and `skills get platform`) and follow them: " +
      "`snapshot --app <App> -i`, act on a ref (`click @snap:eN`, `type @snap:eN` with stdin, `set-value`, `press`, `select`, `scroll`…), then snapshot again to verify. " +
      "Refs belong to their snapshot — on STALE_REF or AMBIGUOUS_TARGET take a new one. Retry only when error.disposition.retry is \"safe\". `screenshot` returns a PNG. " +
      "The user is asked for permission.",
    inputSchema: INPUT_SCHEMA,
  },
  {
    name: "agent_browser",
    cli: "browser",
    description:
      "Browser automation on this machine (the agent-browser CLI: a headless Chrome for Testing over CDP, separate from the user's browser). " +
      "One command per call. Once per conversation run `skills get core` and follow it: `open <url>`, `snapshot -i`, act on a ref (`click @e1`, `fill @e2 <text>`, `press Enter`), " +
      "`get text` / `get url`, `screenshot`. Refs expire on navigation or a DOM change — snapshot again. The browser and its tabs persist between calls; `--session <name>` gives a separate browser. " +
      "The user is asked for permission.",
    inputSchema: INPUT_SCHEMA,
  },
];

// ---------------------------------------------------------------------------
// Finding the binary
// ---------------------------------------------------------------------------

function executable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `v22.23.2` before `v20.18.1`: the newest Node's global installs win. */
function byVersionDesc(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
}

/**
 * Where a CLI the person installed themselves would be. A GUI app does not
 * inherit a shell's PATH, so the usual homes of npm, Homebrew and bun globals
 * are searched after it.
 */
function searchDirs(options) {
  if (Array.isArray(options.searchPath)) return options.searchPath;
  const home = os.homedir();
  const dirs = String((options.env || process.env).PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  const nvm = path.join(home, ".nvm", "versions", "node");
  try {
    for (const version of fs.readdirSync(nvm).sort(byVersionDesc)) dirs.push(path.join(nvm, version, "bin"));
  } catch {
    // no nvm
  }
  dirs.push(path.join(home, ".npm-global", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".local", "bin"));
  return dirs;
}

/** The npm packages shipped with the app: unpacked from the asar when packaged, plain node_modules in development. */
function bundledRoots(options) {
  if (Array.isArray(options.bundledRoots)) return options.bundledRoots;
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"));
  roots.push(path.join(__dirname, "node_modules"));
  return roots;
}

/**
 * A launcher or shim found on PATH stands in for the native binary beside it:
 * `agent-browser` on PATH is a shell shim next to `agent-browser-darwin-arm64`,
 * and the native one is what an Electron process (which has no `node` of its
 * own) can run directly. agent-desktop's PATH entry resolves to its binary
 * already; its macOS helper has to sit in the same folder, which realpath keeps.
 */
function preferNative(spec, file) {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    return file;
  }
  const dir = path.dirname(real);
  for (const rel of spec.bundled) {
    const candidate = path.join(dir, path.basename(rel));
    if (candidate !== real && executable(candidate)) return candidate;
  }
  return real;
}

/**
 * Resolve the binary for one CLI: an explicit path (env, then a setting), the
 * copy bundled with the app, then PATH and the usual global-install folders.
 * `undefined` when nothing runs — the caller words the refusal.
 */
function resolveBinary(cli, options = {}) {
  const spec = CLIS[cli];
  if (!spec) return undefined;
  const env = options.env || process.env;
  const fromEnv = env[spec.envVar];
  if (fromEnv && executable(fromEnv)) return { path: fromEnv, source: "env" };
  if (options.configuredPath && executable(options.configuredPath)) return { path: options.configuredPath, source: "setting" };
  for (const root of bundledRoots(options)) {
    for (const rel of spec.bundled) {
      const candidate = path.join(root, spec.package, rel);
      if (executable(candidate)) return { path: candidate, source: "bundled" };
    }
  }
  for (const dir of searchDirs(options)) {
    for (const name of spec.onPath) {
      const candidate = path.join(dir, name);
      if (executable(candidate)) return { path: preferNative(spec, candidate), source: "path" };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Checking a call
// ---------------------------------------------------------------------------

function refusal(cli, command, reason) {
  return { ok: false, isError: true, content: reason, cli, command, exitCode: null, durationMs: 0 };
}

/**
 * The checks that run before the dialog: a refused command never even asks.
 * Returns the argv the binary gets (minus the binary itself) and the stdin.
 */
function validate(spec, command, args, stdin) {
  if (typeof command !== "string" || !COMMAND_NAME.test(command)) {
    return { ok: false, reason: `command must be a subcommand name like snapshot or click, not ${JSON.stringify(String(command ?? ""))}.` };
  }
  if (spec.refused[command]) {
    return { ok: false, reason: `\`${command}\` is refused in Nexora Desktop: ${spec.refused[command]}.` };
  }
  const list = args === undefined || args === null ? [] : args;
  if (!Array.isArray(list)) return { ok: false, reason: "args must be an array of strings." };
  if (list.length > MAX_ARGS) return { ok: false, reason: `at most ${MAX_ARGS} arguments per call.` };
  for (const arg of list) {
    if (typeof arg !== "string") return { ok: false, reason: "args must be an array of strings." };
    if (arg.length > MAX_ARG_CHARS) return { ok: false, reason: `an argument may be at most ${MAX_ARG_CHARS} characters; pipe long text through stdin.` };
    if (arg.includes("\u0000")) return { ok: false, reason: "an argument may not contain a NUL byte." };
    const flag = arg.split("=")[0];
    if (flag.startsWith("--") && spec.refusedFlags[flag]) {
      return { ok: false, reason: `\`${flag}\` is refused in Nexora Desktop: ${spec.refusedFlags[flag]}.` };
    }
    const lowered = arg.trim().toLowerCase();
    for (const [prefix, why] of Object.entries(spec.refusedArgPrefixes)) {
      if (lowered.startsWith(prefix)) return { ok: false, reason: `\`${prefix}\` URLs are refused in Nexora Desktop: ${why}.` };
    }
  }
  if (spec.pathArgsConfined.has(command)) {
    // The same fence as a local read: outside the workspace folders is outside.
    for (const arg of list) {
      if (!(arg.startsWith("/") || arg.startsWith("~"))) continue;
      try {
        local.resolvePath(arg);
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    }
  }
  const line = `${spec.name} ${command} ${list.join(" ")}`.toLowerCase();
  const blocked = (local.policy().blockedCommands || []).find((pattern) => pattern && line.includes(String(pattern).toLowerCase()));
  if (blocked) return { ok: false, reason: `the command line matches the blocked pattern "${blocked}" (Agent → Local Files → Edit Workspace & Policy…).` };

  let text;
  if (stdin !== undefined && stdin !== null) {
    if (typeof stdin !== "string") return { ok: false, reason: "stdin must be a string." };
    if (stdin.length > MAX_STDIN_CHARS) return { ok: false, reason: `stdin may be at most ${MAX_STDIN_CHARS} characters.` };
    // stdin is text for the commands that read text; anywhere else it would
    // be input the checks above never saw, so it is refused rather than piped.
    if (!spec.stdinCommands.has(command)) {
      const accepts = [...spec.stdinCommands];
      return {
        ok: false,
        reason: accepts.length
          ? `stdin is only accepted by ${spec.name} ${accepts.join(", ")} (as --stdin); pass anything else as an argument.`
          : `${spec.name} takes text as an argument, not on stdin (e.g. fill @e2 "text").`,
      };
    }
    text = stdin;
  }
  const argv = [command, ...list];
  if (text !== undefined && !list.includes("--stdin")) argv.push("--stdin");
  return { ok: true, argv, stdin: text };
}

function clampTimeout(value) {
  const asked = Number(value);
  if (!Number.isFinite(asked)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(asked)));
}

// ---------------------------------------------------------------------------
// Screenshots: an image block, not a wall of base64
// ---------------------------------------------------------------------------

const PNG_B64 = "iVBORw0KGgo";
const JPEG_B64 = "/9j/";

function mediaTypeOfBase64(value) {
  if (value.startsWith(PNG_B64)) return "image/png";
  if (value.startsWith(JPEG_B64)) return "image/jpeg";
  return undefined;
}

/**
 * agent-desktop puts the PNG into its envelope when no PATH is given. The
 * model should see the picture, not read it, so the field is swapped for a
 * placeholder and the bytes travel as an image.
 */
function liftDesktopImage(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {};
  }
  let image;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "string" && value.length >= 256 && !image) {
        const mediaType = mediaTypeOfBase64(value);
        if (mediaType) {
          image = { mediaType, dataBase64: value };
          node[key] = `<image ${Math.round((value.length * 3) / 4 / 1024)} KB, returned as an image block>`;
          continue;
        }
      }
      visit(value);
    }
  };
  visit(envelope);
  return image ? { image, content: JSON.stringify(envelope) } : {};
}

const IMAGE_EXT = /\.(?:png|jpe?g)$/i;

/**
 * agent-browser's `screenshot [selector] [path]` writes a file. The path is
 * ours, not the model's and not one scraped out of the output — the output
 * can repeat page text, and page text could name any file on this machine.
 * A positional that looks like an image path is replaced; a selector stays.
 */
function browserScreenshotArgv(argv) {
  const dir = path.join(os.tmpdir(), "nexora-agent-clis");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const kept = argv.filter((arg, i) => i === 0 || arg.startsWith("-") || !IMAGE_EXT.test(arg));
  return { argv: [...kept, file], file };
}

/** Read the screenshot the host asked for, then remove it; nothing else is read. */
function liftBrowserImage(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return {};
    return { image: { mediaType: "image/png", dataBase64: fs.readFileSync(file).toString("base64") } };
  } catch {
    return {};
  } finally {
    fs.rm(file, { force: true }, () => undefined);
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const BROWSER_MISSING = /agent-browser install|Chrome for Testing[^\n]*not (?:found|installed)|browser (?:is )?not installed|no browser (?:is )?installed/i;

function execute(file, argv, { stdin, timeoutMs, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const binDir = path.dirname(file);
    const child = execFile(
      file,
      argv,
      {
        cwd: os.homedir(),
        env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH || "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}` },
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
          timedOut: Boolean(error && error.killed),
          spawnError: error && typeof error.code === "string" ? error : undefined,
          durationMs: Date.now() - started,
        });
      }
    );
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    }
  });
}

const STDIN_PREVIEW = 160;

/** The command line for the dialog and the audit log — with the text that would be typed, because that is the part the person needs to see. */
function describe(spec, argv, stdin) {
  const line = `${spec.name} ${argv.join(" ")}`.trim();
  if (stdin === undefined) return line;
  const preview = stdin.slice(0, STDIN_PREVIEW).replace(/\r?\n/g, "⏎");
  return `${line} (+ ${stdin.length} chars on stdin: ${JSON.stringify(preview)}${stdin.length > STDIN_PREVIEW ? "…" : ""})`;
}

function audit(action, detail, ok) {
  if (typeof local.audit === "function") local.audit(action, detail, ok);
}

/**
 * Run one command of one CLI.
 *
 * `options.confirm(capability, detail)` is the host's permission gate, exactly
 * as for the local tools; the MCP server passes one that returns true because
 * its host owns the approval prompt. Every outcome is a result object — a
 * refusal, a missing binary, a timeout, a non-zero exit — never a throw, so
 * the model always gets words it can pass on.
 */
async function run(cli, command, args = [], options = {}) {
  const spec = CLIS[cli];
  if (!spec) return refusal(String(cli), String(command ?? ""), `Unknown agent CLI: ${String(cli)}. Use "desktop" or "browser".`);
  if (!local.policy().enabled) {
    return refusal(cli, String(command ?? ""), "Local tools are switched off in Nexora Desktop (Agent → Local Files → Local Tools), and that switch covers the agent CLIs too.");
  }
  const resolved = options.binary ? { path: options.binary, source: "override" } : resolveBinary(cli, options);
  if (!resolved) {
    return refusal(cli, String(command ?? ""), `${spec.name} is not installed on this machine, so this tool cannot run. Install it with: ${spec.install}. Nexora Desktop also ships a copy in newer builds; update the app if yours predates it.`);
  }
  const checked = validate(spec, command, args, options.stdin);
  if (!checked.ok) return refusal(cli, String(command ?? ""), checked.reason);

  const detail = describe(spec, checked.argv, checked.stdin);
  const confirm = options.confirm || (async () => true);
  if (!(await confirm(spec.capability, detail))) {
    audit(`agent-${cli}`, detail, false);
    return refusal(cli, command, "Permission denied by the user.");
  }

  const timeoutMs = clampTimeout(options.timeoutMs);
  let argv = checked.argv;
  let shot;
  if (cli === "browser" && command === "screenshot") ({ argv, file: shot } = browserScreenshotArgv(argv));
  const outcome = await execute(resolved.path, argv, { stdin: checked.stdin, timeoutMs, env: options.env && Object.keys(options.env).length ? { ...process.env, ...options.env } : process.env });

  let content = outcome.stdout;
  let image;
  if (command === "screenshot" && !outcome.timedOut && outcome.exitCode === 0) {
    const lifted = cli === "desktop" ? liftDesktopImage(outcome.stdout) : liftBrowserImage(shot);
    if (lifted.image) {
      image = lifted.image;
      if (lifted.content) content = lifted.content;
    }
  } else if (shot) {
    fs.rm(shot, { force: true }, () => undefined);
  }
  if (content.length > MAX_OUTPUT) {
    content = `${content.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT.toLocaleString()} characters — narrow the command (-i, --compact, --root, a selector)]`;
  }
  const failed = outcome.timedOut || outcome.exitCode !== 0;
  if (outcome.stderr.trim() && failed) content += `\n[stderr] ${outcome.stderr.trim().slice(-STDERR_TAIL)}`;
  if (outcome.timedOut) content += `\n[${spec.name} timed out after ${timeoutMs} ms and was killed]`;
  else if (outcome.spawnError) content += `\n[${spec.name} could not start: ${outcome.spawnError.message}]`;
  else if (outcome.exitCode !== 0) content += `\n[exit ${outcome.exitCode}]`;
  if (cli === "browser" && failed && BROWSER_MISSING.test(`${outcome.stdout}\n${outcome.stderr}`)) {
    content +=
      "\n\nThe headless browser is not installed yet. In Nexora Desktop: Agent → Agent CLIs → Install Browser for Agent Browser… downloads Chrome for Testing once (~190 MB). In a terminal, `agent-browser install` does the same.";
  }

  audit(`agent-${cli}`, failed ? `${detail} — exit ${outcome.exitCode ?? "killed"}` : detail, !failed);
  return {
    ok: !failed,
    ...(failed ? { isError: true } : {}),
    content,
    ...(image ? { image } : {}),
    cli,
    command,
    exitCode: outcome.timedOut ? null : outcome.exitCode,
    durationMs: outcome.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Status and setup
// ---------------------------------------------------------------------------

async function probe(file, argv, env) {
  const out = await execute(file, argv, { timeoutMs: STATUS_TIMEOUT_MS, env });
  return out;
}

/**
 * What the menu shows: for each CLI, whether it was found and where, its
 * version, and for agent-desktop the permission states it reports (the
 * Accessibility and Screen Recording grants go to Nexora Desktop, because the
 * CLI runs as its child).
 */
async function status(options = {}) {
  const env = options.env && Object.keys(options.env).length ? { ...process.env, ...options.env } : process.env;
  const report = {};
  for (const [cli, spec] of Object.entries(CLIS)) {
    const resolved = resolveBinary(cli, options);
    if (!resolved) {
      report[cli] = { found: false, install: spec.install };
      continue;
    }
    const entry = { found: true, path: resolved.path, source: resolved.source };
    const version = await probe(resolved.path, ["--version"], env);
    entry.version = (version.stdout || version.stderr).trim().split("\n")[0] || undefined;
    if (cli === "desktop") {
      const st = await probe(resolved.path, ["status"], env);
      try {
        const envelope = JSON.parse(st.stdout);
        entry.permissions = envelope?.data?.permissions;
        entry.platform = envelope?.data?.platform;
      } catch {
        entry.permissions = undefined;
      }
    }
    report[cli] = entry;
  }
  return report;
}

/** `agent-browser install`: Chrome for Testing, once per user. Lines stream to `onLine` for a progress notification. */
function installBrowser(options = {}) {
  const resolved = resolveBinary("browser", options);
  if (!resolved) return Promise.resolve({ ok: false, output: `agent-browser is not installed. ${CLIS.browser.install}` });
  return new Promise((resolve) => {
    const chunks = [];
    const child = execFile(
      resolved.path,
      ["install"],
      { cwd: os.homedir(), env: { ...process.env, PATH: `${path.dirname(resolved.path)}${path.delimiter}${process.env.PATH || ""}` }, timeout: INSTALL_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim(), error: error ? error.message : undefined });
      }
    );
    const onData = (data) => {
      chunks.push(String(data));
      if (typeof options.onLine === "function") {
        for (const line of String(data).split(/\r?\n/)) if (line.trim()) options.onLine(line.trim());
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.end();
  });
}

/** Run the CLI's own permission guide (opens System Settings on macOS). Not gated: the person clicked a menu item. */
function openDesktopPermissionGuide(options = {}) {
  const resolved = resolveBinary("desktop", options);
  if (!resolved) return Promise.resolve({ ok: false, output: `agent-desktop is not installed. ${CLIS.desktop.install}` });
  return probe(resolved.path, ["permissions", "--guide"], process.env).then((out) => ({ ok: out.exitCode === 0, output: `${out.stdout}${out.stderr}`.trim() }));
}

module.exports = {
  CLIS,
  TOOL_DEFS,
  resolveBinary,
  run,
  status,
  installBrowser,
  openDesktopPermissionGuide,
};
