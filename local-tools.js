const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Nexora Desktop — the local workspace.
 *
 * Files, search and long-lived processes on this machine, in one place. The
 * Electron bridge (`main.js`) and the stdio MCP server (`mcp-server.js`) both
 * call `runLocal`, so Nexora and Claude Desktop get the same tools with the
 * same guardrails rather than two implementations that drift.
 *
 * Nothing here imports Electron: the MCP server runs as a bare Node process.
 * The caller supplies where settings live and how to ask the user, which is
 * the only part that differs between the two hosts.
 *
 * Two guardrails apply to every call. `allowedDirectories` scopes file work to
 * folders the user picked — empty means "anywhere", which is what the app has
 * always done, so adding a folder tightens rather than loosens. Every call is
 * appended to an audit log the user can read. Neither is a sandbox: a shell
 * command can still reach the whole machine, which is the point of a shell.
 */

const MAX_OUTPUT = 100_000; // chars of any single result fed back to the model
const MAX_READ_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 3_500_000;
const PROCESS_BUFFER = 200_000; // chars retained per running process
const SEARCH_MAX_FILES = 20_000; // files walked before a search gives up
const FUZZY_MAX_LINES = 20_000; // file size past which we skip the fuzzy hunt

const DEFAULT_POLICY = {
  enabled: true,
  /** Empty = every path the user approves in the dialog. Non-empty = only these trees. */
  allowedDirectories: [],
  /** Matched as a substring of the command line, case-insensitively. */
  blockedCommands: ["mkfs", "shutdown ", "reboot", "halt", "diskutil eraseDisk", "dd if=/dev/", ":(){:|:&};:"],
  readLineLimit: 1000,
  writeLineLimit: 50,
  audit: true,
};

let dataDir = path.join(os.homedir(), "Library", "Application Support", "Nexora Desktop");
let host = "app";
let cached = null;

/**
 * Where settings and the audit log live, and who is calling.
 *
 * Electron passes its own userData path (the same folder this defaults to, so
 * the MCP server finds one policy file either way). `host` is stamped on every
 * audit line: with two front ends sharing one log, "which one did this" is the
 * first question anyone reading it will have.
 */
function configure(options = {}) {
  if (options.dataDir) {
    dataDir = options.dataDir;
    cached = null;
  }
  if (options.host) host = String(options.host);
}

function policyFile() {
  return path.join(dataDir, "local-settings.json");
}

function policy() {
  if (cached) return cached;
  cached = { ...DEFAULT_POLICY, allowedDirectories: [], blockedCommands: [...DEFAULT_POLICY.blockedCommands] };
  try {
    const saved = JSON.parse(fs.readFileSync(policyFile(), "utf8"));
    if (typeof saved.enabled === "boolean") cached.enabled = saved.enabled;
    if (typeof saved.audit === "boolean") cached.audit = saved.audit;
    for (const key of ["readLineLimit", "writeLineLimit"]) {
      if (Number.isFinite(saved[key]) && saved[key] > 0) cached[key] = Math.floor(saved[key]);
    }
    for (const key of ["allowedDirectories", "blockedCommands"]) {
      if (Array.isArray(saved[key])) cached[key] = saved[key].map(String).filter(Boolean);
    }
  } catch {
    // No settings file yet, or an unreadable one: the defaults above stand.
  }
  return cached;
}

function savePolicy(next) {
  if (next) cached = { ...policy(), ...next };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(policyFile(), `${JSON.stringify(policy(), null, 2)}\n`, "utf8");
  } catch {
    // A settings file we cannot write is not worth failing a tool call over.
  }
  return policy();
}

function reloadPolicy() {
  cached = null;
  return policy();
}

/** One line per call, so "what did the agent touch" is answerable after the fact. */
function audit(action, detail, ok) {
  if (!policy().audit) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), host, action, detail: String(detail).slice(0, 400), ok });
    fs.appendFileSync(path.join(dataDir, "local-tools.log"), `${line}\n`, "utf8");
  } catch {
    // Same reasoning as above.
  }
}

function auditFile() {
  return path.join(dataDir, "local-tools.log");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function expandHome(p) {
  const raw = String(p ?? "").trim();
  if (!raw) throw new Error("path is required");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.resolve(path.join(os.homedir(), raw.slice(2)));
  return path.resolve(raw);
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a path and check it against the workspace scope.
 *
 * The check is on the resolved path, so `~/work/../../etc/passwd` is measured
 * where it lands rather than where it was written.
 */
function resolvePath(p) {
  const target = expandHome(p);
  const allowed = policy().allowedDirectories;
  if (allowed.length && !allowed.some((dir) => within(expandHome(dir), target))) {
    throw new Error(
      `${target} is outside the Nexora workspace. Allowed: ${allowed.join(", ")}. ` +
        "Add the folder under Agent → Local Files → Workspace Folders… to reach it."
    );
  }
  return target;
}

function clamp(text, limit = MAX_OUTPUT) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n[truncated — ${s.length - limit} more characters]`;
}

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a file, or a window of its lines.
 *
 * A whole file is rarely what anyone wants past a few hundred lines, so reads
 * are paged: `offset` is a starting line, and a NEGATIVE offset counts from the
 * end, which is how you tail a log without a shell. Images come back as images.
 */
function readFileTool(input) {
  const target = resolvePath(input.path);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error(`${target} is a folder — use local_list_dir.`);

  const ext = path.extname(target).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image too large (${humanSize(stat.size)}; limit ${humanSize(MAX_IMAGE_BYTES)}).`);
    return {
      path: target,
      bytes: stat.size,
      image: { mediaType: IMAGE_TYPES[ext], dataBase64: fs.readFileSync(target).toString("base64") },
    };
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${humanSize(stat.size)}; limit ${humanSize(MAX_READ_BYTES)}). Read a line range or search it instead.`);
  }

  const raw = fs.readFileSync(target, "utf8");
  // A file with NUL bytes in the first few KB is binary; returning mojibake
  // helps nobody, and the model will happily "read" it and hallucinate.
  if (raw.slice(0, 4096).includes("\u0000")) {
    return { path: target, bytes: stat.size, binary: true, content: `Binary file (${humanSize(stat.size)}) — not shown.` };
  }

  const lines = raw.split("\n");
  const limit = Math.min(Number(input.length) > 0 ? Math.floor(Number(input.length)) : policy().readLineLimit, 50_000);
  const asked = Number(input.offset);
  const offset = Number.isFinite(asked) ? Math.floor(asked) : 0;
  const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.min(offset, lines.length);
  const end = Math.min(lines.length, start + limit);
  const slice = lines.slice(start, end);

  return {
    path: target,
    bytes: stat.size,
    totalLines: lines.length,
    firstLine: start + 1,
    lastLine: end,
    truncated: end < lines.length || start > 0,
    content: clamp(slice.join("\n")),
  };
}

/** A URL, fetched and flattened to text. The same tool, pointed at the web. */
async function readUrl(url) {
  const target = String(url);
  if (!/^https?:\/\//i.test(target)) throw new Error("isUrl needs an http or https URL.");
  const response = await fetch(target, { headers: { "user-agent": "NexoraDesktop/1.4" }, redirect: "follow" });
  const type = response.headers.get("content-type") || "";
  if (/^image\//.test(type)) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { url: target, bytes: buffer.length, image: { mediaType: type.split(";")[0], dataBase64: buffer.toString("base64") } };
  }
  const body = await response.text();
  const text = /html/i.test(type)
    ? body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
    : body;
  return { url: target, status: response.status, content: clamp(text) };
}

function readManyTool(input) {
  const paths = Array.isArray(input.paths) ? input.paths.slice(0, 25) : [];
  if (!paths.length) throw new Error("paths is required");
  const budget = Math.floor(MAX_OUTPUT / paths.length);
  const parts = paths.map((p) => {
    try {
      const file = readFileTool({ path: p, length: input.length });
      if (file.image) return `--- ${file.path} ---\n[image, ${humanSize(file.bytes)} — read it on its own to see it]`;
      return `--- ${file.path} (${file.totalLines ?? "?"} lines) ---\n${clamp(file.content, budget)}`;
    } catch (error) {
      return `--- ${p} ---\n[${error.message}]`;
    }
  });
  return { content: parts.join("\n\n") };
}

// ---------------------------------------------------------------------------
// Writing and editing
// ---------------------------------------------------------------------------

function writeFileTool(input) {
  const target = resolvePath(input.path);
  const content = String(input.content ?? "");
  const append = String(input.mode || "rewrite") === "append";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (append) fs.appendFileSync(target, content, "utf8");
  else fs.writeFileSync(target, content, "utf8");

  const lines = content.split("\n").length;
  const limit = policy().writeLineLimit;
  return {
    path: target,
    mode: append ? "append" : "rewrite",
    lines,
    bytes: fs.statSync(target).size,
    // The advice Desktop Commander gives, for the same reason: a single huge
    // write is where models truncate silently. Chunking keeps each call small
    // enough to come back whole.
    note: lines > limit ? `Wrote ${lines} lines in one call. Prefer chunks of ${limit} or fewer, continuing with mode:"append".` : undefined,
  };
}

function bigrams(text) {
  const out = new Map();
  const s = text.replace(/\s+/g, " ").toLowerCase();
  for (let i = 0; i < s.length - 1; i += 1) {
    const pair = s.slice(i, i + 2);
    out.set(pair, (out.get(pair) || 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams — cheap, and good enough to rank near-misses. */
function similarity(a, b) {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const [pair, count] of right) {
    total += count;
    const have = left.get(pair);
    if (have) shared += Math.min(have, count);
  }
  return total ? (2 * shared) / total : 0;
}

/** Mark what differs, the way a reviewer would read it: {-gone-}{+new+}. */
function inlineDiff(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  return `${before.slice(0, head)}{-${removed}-}{+${added}+}${before.slice(before.length - tail)}`;
}

/**
 * Replace one exact block of text.
 *
 * Surgical by design: the agent quotes the lines it means, we count them, and
 * a count that isn't what it expected is an error rather than a guess. When
 * there is no exact match we do NOT approximate — we find the closest block,
 * show it with the differences marked, and let the agent decide. Silently
 * editing the nearly-right place is the worst outcome available here.
 */
function editFileTool(input) {
  const target = resolvePath(input.path);
  const oldText = String(input.oldText ?? "");
  const newText = String(input.newText ?? "");
  if (!oldText) throw new Error("oldText is required — quote the exact block to replace.");
  const raw = fs.readFileSync(target, "utf8");

  const occurrences = raw.split(oldText).length - 1;
  const expected = Number.isFinite(Number(input.expected)) ? Math.max(1, Math.floor(Number(input.expected))) : 1;

  if (occurrences === 0) {
    const lines = raw.split("\n");
    const needle = oldText.split("\n");
    let best = { score: 0, at: -1, text: "" };
    if (lines.length <= FUZZY_MAX_LINES) {
      for (let i = 0; i + needle.length <= lines.length; i += 1) {
        const window = lines.slice(i, i + needle.length).join("\n");
        const score = similarity(oldText, window);
        if (score > best.score) best = { score, at: i + 1, text: window };
      }
    }
    if (best.score < 0.55) {
      return { path: target, applied: 0, error: `No match for that block in ${target}, and nothing close to it. Read the file and quote the current text.` };
    }
    return {
      path: target,
      applied: 0,
      error:
        `No exact match. The closest block is at line ${best.at} (${Math.round(best.score * 100)}% similar). ` +
        "Differences are marked {-yours-}{+the file's+}:\n\n" +
        clamp(inlineDiff(oldText, best.text), 4000) +
        "\n\nQuote the file's text exactly, then retry.",
    };
  }
  if (occurrences !== expected) {
    return {
      path: target,
      applied: 0,
      error: `Found ${occurrences} occurrences but expected ${expected}. Pass expected:${occurrences} to change them all, or quote more surrounding lines to single one out.`,
    };
  }

  fs.writeFileSync(target, raw.split(oldText).join(newText), "utf8");
  return { path: target, applied: occurrences, bytes: fs.statSync(target).size };
}

// ---------------------------------------------------------------------------
// Browsing the filesystem
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".cache", "Library"]);

function listDirTool(input) {
  const target = resolvePath(input.path || "~");
  const depth = Math.min(Math.max(Number(input.depth) || 1, 1), 4);
  const rows = [];
  let truncated = false;

  const walk = (dir, level, prefix) => {
    if (truncated || level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      rows.push(`${prefix}[${error.code || "unreadable"}]`);
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= 1000) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && !input.hidden) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        rows.push(`${prefix}${entry.name}/`);
        if (level < depth && !SKIP_DIRS.has(entry.name)) walk(full, level + 1, `${prefix}  `);
      } else {
        let size = "";
        try {
          size = ` (${humanSize(fs.statSync(full).size)})`;
        } catch {
          // A broken symlink still deserves a line.
        }
        rows.push(`${prefix}${entry.name}${size}`);
      }
    }
  };

  walk(target, 1, "");
  return { path: target, depth, entries: rows.length, truncated, content: clamp(rows.join("\n")) };
}

function fileInfoTool(input) {
  const target = resolvePath(input.path);
  const stat = fs.lstatSync(target);
  return {
    path: target,
    kind: stat.isDirectory() ? "folder" : stat.isSymbolicLink() ? "symlink" : "file",
    bytes: stat.size,
    size: humanSize(stat.size),
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    mode: (stat.mode & 0o777).toString(8),
    lines: stat.isFile() && stat.size < MAX_READ_BYTES ? fs.readFileSync(target, "utf8").split("\n").length : undefined,
  };
}

function moveTool(input) {
  const from = resolvePath(input.from);
  const to = resolvePath(input.to);
  if (fs.existsSync(to) && !input.overwrite) throw new Error(`${to} already exists. Pass overwrite:true to replace it.`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    // Across volumes rename fails; copy then remove is what `mv` does too.
    if (error.code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return { from, to };
}

function mkdirTool(input) {
  const target = resolvePath(input.path);
  fs.mkdirSync(target, { recursive: true });
  return { path: target, created: true };
}

function deleteTool(input) {
  const target = resolvePath(input.path);
  const home = os.homedir();
  if (target === "/" || target === home || path.dirname(target) === "/") throw new Error(`Refusing to delete ${target}.`);
  const stat = fs.lstatSync(target);
  fs.rmSync(target, { recursive: true, force: false });
  return { path: target, deleted: true, kind: stat.isDirectory() ? "folder" : "file" };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function ripgrep(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile("rg", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // Exit 1 is "no matches", which is an answer, not a failure. ENOENT means
      // ripgrep isn't installed and the caller should walk the tree itself.
      if (error && error.code === "ENOENT") resolve(null);
      else resolve(String(stdout || ""));
    });
  });
}

function walkFiles(root, onFile, deadline) {
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    if (seen >= SEARCH_MAX_FILES || Date.now() > deadline) return { seen, truncated: true };
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        seen += 1;
        if (onFile(full) === false) return { seen, truncated: false };
      }
    }
  }
  return { seen, truncated: false };
}

/**
 * Find files by name, or lines by content.
 *
 * ripgrep when the machine has it — it is an order of magnitude faster on a
 * real source tree — and a bounded walk when it doesn't, so the tool works on
 * a stock Mac. Both are capped by a deadline and a result count, and say so
 * when they stop early rather than implying the tree held nothing more.
 */
async function searchTool(input) {
  const root = resolvePath(input.path || "~");
  const pattern = String(input.pattern ?? "").trim();
  if (!pattern) throw new Error("pattern is required");
  const mode = String(input.mode || "content") === "files" ? "files" : "content";
  const max = Math.min(Math.max(Number(input.maxResults) || 100, 1), 1000);
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 15_000, 1000), 60_000);
  const deadline = Date.now() + timeoutMs;
  const flags = input.caseSensitive ? [] : ["-i"];

  if (mode === "files") {
    const out = await ripgrep(["--files", ...(input.glob ? ["-g", String(input.glob)] : []), root], timeoutMs);
    if (out !== null) {
      const test = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), input.caseSensitive ? "" : "i");
      const hits = out.split("\n").filter((line) => line && test.test(path.basename(line)));
      return { root, mode, matches: hits.length, truncated: hits.length > max, content: clamp(hits.slice(0, max).join("\n")) };
    }
    const test = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), input.caseSensitive ? "" : "i");
    const hits = [];
    const { truncated } = walkFiles(
      root,
      (file) => {
        if (test.test(path.basename(file))) hits.push(file);
        return hits.length < max;
      },
      deadline
    );
    return { root, mode, matches: hits.length, truncated: truncated || hits.length >= max, content: clamp(hits.join("\n")) };
  }

  const rgArgs = [...flags, "-n", "--no-heading", "--color", "never", "-m", "5", "--max-columns", "300"];
  if (input.glob) rgArgs.push("-g", String(input.glob));
  if (input.literal !== false) rgArgs.push("-F");
  rgArgs.push(pattern, root);
  const out = await ripgrep(rgArgs, timeoutMs);
  if (out !== null) {
    const lines = out.split("\n").filter(Boolean);
    return { root, mode, matches: lines.length, truncated: lines.length > max, content: clamp(lines.slice(0, max).join("\n")) };
  }

  const test = input.literal === false ? new RegExp(pattern, input.caseSensitive ? "" : "i") : null;
  const needle = input.caseSensitive ? pattern : pattern.toLowerCase();
  const hits = [];
  const { truncated } = walkFiles(
    root,
    (file) => {
      let body;
      try {
        if (fs.statSync(file).size > MAX_READ_BYTES) return true;
        body = fs.readFileSync(file, "utf8");
      } catch {
        return true;
      }
      if (body.includes("\u0000")) return true;
      const lines = body.split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i += 1) {
        const line = input.caseSensitive ? lines[i] : lines[i].toLowerCase();
        const found = test ? test.test(lines[i]) : line.includes(needle);
        if (found) hits.push(`${file}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
      return hits.length < max;
    },
    deadline
  );
  return { root, mode, matches: hits.length, truncated: truncated || hits.length >= max, content: clamp(hits.join("\n")) };
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const sessions = new Map(); // pid -> live process

function blockedCommand(command) {
  const lower = command.toLowerCase();
  const hit = policy().blockedCommands.find((entry) => lower.includes(String(entry).toLowerCase()));
  if (hit) return hit;
  if (/\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+\/(\s|$)/.test(lower)) return "rm -rf /";
  return null;
}

function appendOutput(session, chunk) {
  session.buffer += chunk;
  if (session.buffer.length > PROCESS_BUFFER) {
    const drop = session.buffer.length - PROCESS_BUFFER;
    session.buffer = session.buffer.slice(drop);
    session.cursor = Math.max(0, session.cursor - drop);
  }
}

/**
 * Wait for the process to go quiet.
 *
 * A REPL never "finishes", so waiting for exit would hang on every one. What
 * actually marks the end of a reply is the output stopping, so we watch for a
 * gap and return then — with a hard ceiling for a process that chatters.
 */
function drain(session, timeoutMs, quietMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastLength = session.buffer.length;
    let lastChange = Date.now();
    const tick = setInterval(() => {
      if (session.buffer.length !== lastLength) {
        lastLength = session.buffer.length;
        lastChange = Date.now();
      }
      const quiet = Date.now() - lastChange >= quietMs && session.buffer.length > session.cursor;
      if (!session.running || quiet || Date.now() - started >= timeoutMs) {
        clearInterval(tick);
        resolve();
      }
    }, 60);
  });
}

function takeOutput(session) {
  const fresh = session.buffer.slice(session.cursor);
  session.cursor = session.buffer.length;
  return clamp(fresh);
}

function describe(session) {
  return {
    pid: session.pid,
    command: session.command,
    cwd: session.cwd,
    running: session.running,
    exitCode: session.exitCode,
    runningForMs: Date.now() - session.started,
  };
}

async function processTool(input) {
  const op = String(input.op || "list");

  if (op === "list") {
    return { sessions: [...sessions.values()].map(describe) };
  }

  if (op === "start") {
    const command = String(input.command ?? "").trim();
    if (!command) throw new Error("command is required");
    const blocked = blockedCommand(command);
    if (blocked) throw new Error(`Refusing to run a command containing "${blocked}".`);
    const cwd = input.cwd ? resolvePath(input.cwd) : os.homedir();
    // TERM=dumb keeps ANSI escapes out of the transcript and PAGER=cat stops
    // anything that would sit forever waiting for a keypress in `less`.
    const child = spawn(command, {
      cwd,
      shell: "/bin/zsh",
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" },
    });
    const session = {
      pid: child.pid,
      child,
      command,
      cwd,
      started: Date.now(),
      buffer: "",
      cursor: 0,
      running: true,
      exitCode: null,
    };
    child.stdout.on("data", (d) => appendOutput(session, d.toString()));
    child.stderr.on("data", (d) => appendOutput(session, d.toString()));
    child.on("error", (error) => appendOutput(session, `\n[spawn failed: ${error.message}]\n`));
    child.on("close", (code) => {
      session.running = false;
      session.exitCode = code;
    });
    sessions.set(session.pid, session);
    await drain(session, Math.min(Number(input.timeoutMs) || 10_000, 120_000), Number(input.quietMs) || 400);
    return { ...describe(session), output: takeOutput(session) };
  }

  const session = sessions.get(Number(input.pid));
  // Deliberately host-neutral: the tool is `local_process` in Nexora and
  // `process` over MCP, and naming the wrong one sends the agent hunting.
  if (!session) throw new Error(`No process ${input.pid}. Use the process tool with op:"list" to see what is running.`);

  if (op === "input") {
    if (!session.running) throw new Error(`Process ${session.pid} has exited (code ${session.exitCode}).`);
    session.child.stdin.write(`${String(input.text ?? "")}\n`);
    await drain(session, Math.min(Number(input.timeoutMs) || 15_000, 120_000), Number(input.quietMs) || 400);
    return { ...describe(session), output: takeOutput(session) };
  }
  if (op === "read") {
    await drain(session, Math.min(Number(input.timeoutMs) || 5_000, 120_000), Number(input.quietMs) || 300);
    return { ...describe(session), output: takeOutput(session) };
  }
  if (op === "kill") {
    session.child.kill("SIGKILL");
    session.running = false;
    const out = { ...describe(session), output: takeOutput(session), killed: true };
    sessions.delete(session.pid);
    return out;
  }
  throw new Error(`Unknown process op: ${op}. Use start, input, read, kill or list.`);
}

/** Nothing the agent started should outlive the app. Returns how many died. */
function killAllProcesses() {
  const count = sessions.size;
  for (const session of sessions.values()) {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  sessions.clear();
  return count;
}

function shellTool(input) {
  const command = String(input.command ?? "").trim();
  if (!command) throw new Error("command is required");
  const blocked = blockedCommand(command);
  if (blocked) throw new Error(`Refusing to run a command containing "${blocked}".`);
  const cwd = input.cwd ? resolvePath(input.cwd) : os.homedir();
  const timeout = Math.min(Math.max(Number(input.timeoutMs) || 120_000, 1000), 600_000);
  return new Promise((resolve) => {
    execFile(
      "/bin/zsh",
      ["-lc", command],
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TERM: "dumb", PAGER: "cat", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolve({
          cwd,
          exitCode: error ? Number(error.code ?? 1) || 1 : 0,
          timedOut: Boolean(error && error.killed),
          stdout: clamp(stdout),
          stderr: clamp(stderr),
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Scheduled tasks
//
// A schedule is a sentence and a cadence — "tidy my Downloads folder, daily at
// 9am". This file only keeps the list and works out when each one is next due;
// running them belongs to whoever is holding the agent. Nexora Desktop ticks
// this list while it is open, which is also the honest limit: a machine that is
// asleep runs nothing, and a missed run fires once when the app comes back
// rather than replaying every occurrence it slept through.
// ---------------------------------------------------------------------------

const MAX_SCHEDULES = 50;
const MIN_INTERVAL_MINUTES = 5;
const DAY_PREFIXES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CADENCE_HELP =
  'Say when like "every 30 minutes", "hourly", "daily at 9am", "weekdays at 08:30", "every monday at 17:00", or "once at 2026-08-05 09:00".';

function scheduleFile() {
  return path.join(dataDir, "schedules.json");
}

function readSchedules() {
  try {
    const saved = JSON.parse(fs.readFileSync(scheduleFile(), "utf8"));
    return Array.isArray(saved.schedules) ? saved.schedules : [];
  } catch {
    return [];
  }
}

function writeSchedules(list) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(scheduleFile(), `${JSON.stringify({ schedules: list }, null, 2)}\n`, "utf8");
  return list;
}

function parseTimeOfDay(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(String(text).trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Turn "every monday at 17:00" into something with arithmetic in it. */
function parseCadence(raw) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!text) throw new Error(CADENCE_HELP);

  if (text === "hourly") return { kind: "interval", minutes: 60 };
  if (text === "daily" || text === "every day") return { kind: "daily", hour: 9, minute: 0 };

  let m = /^(?:every )?(\d+) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(text);
  if (m) {
    const minutes = Number(m[1]) * (m[2].startsWith("h") ? 60 : 1);
    if (minutes < MIN_INTERVAL_MINUTES) throw new Error(`The shortest interval is ${MIN_INTERVAL_MINUTES} minutes.`);
    return { kind: "interval", minutes };
  }

  m = /^(?:every day|each day|daily) at (.+)$/.exec(text);
  if (m) {
    const time = parseTimeOfDay(m[1]);
    if (time) return { kind: "daily", ...time };
  }

  m = /^(?:every |each )?weekdays? at (.+)$/.exec(text);
  if (m) {
    const time = parseTimeOfDay(m[1]);
    if (time) return { kind: "weekdays", ...time };
  }

  m = /^(?:every |each |on )?(sun|mon|tue|wed|thu|fri|sat)[a-z]* at (.+)$/.exec(text);
  if (m) {
    const time = parseTimeOfDay(m[2]);
    if (time) return { kind: "weekly", day: DAY_PREFIXES.indexOf(m[1]), ...time };
  }

  // Anything else is a one-shot date. Parse the ORIGINAL text, not the
  // lowercased copy — "2026-08-05T09:00" needs its capital T.
  const at = new Date(String(raw).trim().replace(/^once (?:at |on )?/i, ""));
  if (!Number.isNaN(at.getTime())) return { kind: "once", at: at.toISOString() };
  throw new Error(CADENCE_HELP);
}

const clockOf = (spec) => `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;

function describeCadence(spec) {
  switch (spec?.kind) {
    case "interval":
      return spec.minutes % 60 === 0 ? `every ${spec.minutes / 60}h` : `every ${spec.minutes}m`;
    case "daily":
      return `daily at ${clockOf(spec)}`;
    case "weekdays":
      return `weekdays at ${clockOf(spec)}`;
    case "weekly":
      return `every ${DAY_NAMES[spec.day]} at ${clockOf(spec)}`;
    case "once":
      return `once at ${new Date(spec.at).toLocaleString()}`;
    default:
      return "on an unreadable cadence";
  }
}

/** The next time this cadence comes round, in local time. null = never again. */
function computeNext(spec, from = Date.now()) {
  if (spec.kind === "interval") return new Date(from + spec.minutes * 60_000).toISOString();
  if (spec.kind === "once") {
    const at = new Date(spec.at).getTime();
    return at > from ? new Date(at).toISOString() : null;
  }
  const next = new Date(from);
  next.setHours(spec.hour, spec.minute, 0, 0);
  const advance = () => next.setDate(next.getDate() + 1);
  if (next.getTime() <= from) advance();
  if (spec.kind === "weekly") while (next.getDay() !== spec.day) advance();
  if (spec.kind === "weekdays") while (next.getDay() === 0 || next.getDay() === 6) advance();
  return next.toISOString();
}

const publicSchedule = (task) => ({
  id: task.id,
  goal: task.goal,
  cadence: describeCadence(task.every),
  nextRunAt: task.enabled ? task.nextRunAt : null,
  lastRunAt: task.lastRunAt ?? null,
  runs: task.runs ?? 0,
  enabled: Boolean(task.enabled),
});

function renderSchedules(list) {
  if (!list.length) return "No scheduled tasks.";
  return list
    .map((task) => {
      const when = task.enabled
        ? `next ${new Date(task.nextRunAt).toLocaleString()}`
        : task.every?.kind === "once" && task.runs
          ? "done"
          : "paused";
      return `${task.id}  ${task.goal}\n    ${describeCadence(task.every)} — ${when}`;
    })
    .join("\n");
}

function findSchedule(list, id) {
  const task = list.find((t) => t.id === String(id));
  if (!task) throw new Error(`No scheduled task ${id}. Use op:"list" to see them.`);
  return task;
}

function scheduleTool(input) {
  const op = String(input.op || "list");
  const list = readSchedules();

  switch (op) {
    case "list":
      return { schedules: list.map(publicSchedule), content: renderSchedules(list) };

    case "add": {
      const goal = String(input.goal ?? "").trim();
      if (!goal) throw new Error("goal is required — say what the agent should do when this fires.");
      if (list.length >= MAX_SCHEDULES) throw new Error(`That is ${MAX_SCHEDULES} scheduled tasks already. Remove one first.`);
      const every = parseCadence(input.every ?? input.when);
      const nextRunAt = computeNext(every);
      if (!nextRunAt) throw new Error("That time has already passed.");
      const used = new Set(list.map((t) => t.id));
      let n = 1;
      while (used.has(`t${n}`)) n += 1;
      const task = {
        id: `t${n}`,
        goal,
        every,
        nextRunAt,
        lastRunAt: null,
        runs: 0,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      writeSchedules([...list, task]);
      return {
        schedule: publicSchedule(task),
        content: `Scheduled ${task.id}: ${goal}\n${describeCadence(every)} — first run ${new Date(nextRunAt).toLocaleString()}.\nIt runs in Nexora Desktop, so the app has to be open at the time.`,
      };
    }

    case "remove": {
      const task = findSchedule(list, input.id);
      writeSchedules(list.filter((t) => t.id !== task.id));
      return { content: `Removed ${task.id}: ${task.goal}` };
    }

    case "enable":
    case "disable": {
      const task = findSchedule(list, input.id);
      task.enabled = op === "enable";
      if (task.enabled) task.nextRunAt = computeNext(task.every);
      if (task.enabled && !task.nextRunAt) throw new Error("That one-shot time has passed — remove it or add a new one.");
      writeSchedules(list);
      return { schedule: publicSchedule(task), content: `${task.id} is now ${task.enabled ? "on" : "paused"}.` };
    }

    case "run": {
      const task = findSchedule(list, input.id);
      task.enabled = true;
      task.nextRunAt = new Date().toISOString();
      writeSchedules(list);
      return { schedule: publicSchedule(task), content: `${task.id} is queued — Nexora Desktop picks it up within a minute if it is open.` };
    }

    default:
      throw new Error(`Unknown schedule op: ${op}. Use list, add, remove, enable, disable or run.`);
  }
}

/**
 * Everything due now, with the clock already moved on.
 *
 * The caller gets each task exactly once: this stamps `lastRunAt` and rolls
 * `nextRunAt` forward before returning, so a slow run or a crash mid-task can
 * never turn one schedule into a loop.
 */
function dueSchedules(now = Date.now()) {
  const list = readSchedules();
  const due = [];
  for (const task of list) {
    if (!task.enabled || !task.nextRunAt) continue;
    if (new Date(task.nextRunAt).getTime() > now) continue;
    due.push({ id: task.id, goal: task.goal, cadence: describeCadence(task.every) });
    task.lastRunAt = new Date(now).toISOString();
    task.runs = (task.runs ?? 0) + 1;
    // Once means once, even when "Run Now" fired it ahead of its own time.
    task.nextRunAt = task.every?.kind === "once" ? null : computeNext(task.every, now);
    if (!task.nextRunAt) task.enabled = false;
  }
  if (due.length) {
    try {
      writeSchedules(list);
    } catch {
      // An unwritable file would otherwise replay the same task every tick.
      return [];
    }
  }
  return due;
}

// ---------------------------------------------------------------------------

/** Which permission each action asks for, and how to describe it in the dialog. */
const CAPABILITY = {
  read: "read",
  readMany: "read",
  write: "write",
  edit: "write",
  list: "list",
  info: "list",
  search: "search",
  move: "write",
  mkdir: "write",
  delete: "delete",
  process: "process",
  shell: "shell",
  policy: null,
  // Reading the list is free; changing what the machine will do later is not.
  schedule: (input) => (String(input.op || "list") === "list" ? null : "schedule"),
};

function detailFor(action, input) {
  switch (action) {
    case "shell":
      return `${input.command}\n\nin ${input.cwd || os.homedir()}`;
    case "process":
      return input.op === "start" ? `${input.command}\n\nin ${input.cwd || os.homedir()}` : `${input.op} on process ${input.pid ?? ""}`;
    case "readMany":
      return (Array.isArray(input.paths) ? input.paths : []).join("\n");
    case "search":
      return `${input.pattern}\n\nunder ${input.path || "~"}`;
    case "move":
      return `${input.from}\n→ ${input.to}`;
    case "edit":
      return `${input.path}\n\n${String(input.oldText ?? "").slice(0, 400)}`;
    case "schedule":
      return input.op === "add"
        ? `${input.goal}\n\n${input.every ?? input.when ?? ""}`
        : `${input.op} ${input.id ?? ""}`;
    default:
      return String(input.path ?? "");
  }
}

/**
 * Run one local action.
 *
 * `confirm(capability, detail)` is the host's permission gate: Electron shows a
 * native dialog, the MCP server relies on Claude Desktop's own approval and
 * passes a function that returns true. Either way the call is logged.
 */
async function runLocal(action, input = {}, options = {}) {
  const confirm = options.confirm || (async () => true);
  if (!policy().enabled && action !== "policy") {
    throw new Error("Local tools are switched off in Nexora Desktop (Agent → Local Files → Local Tools).");
  }

  const gate = CAPABILITY[action];
  if (gate === undefined) throw new Error(`Unknown local action: ${action}`);
  const capability = typeof gate === "function" ? gate(input) : gate;
  if (capability && !(await confirm(capability, detailFor(action, input)))) {
    audit(action, detailFor(action, input), false);
    throw new Error("Permission denied by the user.");
  }

  try {
    const result = await (async () => {
      switch (action) {
        case "read":
          return input.isUrl ? readUrl(input.path || input.url) : readFileTool(input);
        case "readMany":
          return readManyTool(input);
        case "write":
          return writeFileTool(input);
        case "edit":
          return editFileTool(input);
        case "list":
          return listDirTool(input);
        case "info":
          return fileInfoTool(input);
        case "search":
          return searchTool(input);
        case "move":
          return moveTool(input);
        case "mkdir":
          return mkdirTool(input);
        case "delete":
          return deleteTool(input);
        case "process":
          return processTool(input);
        case "shell":
          return shellTool(input);
        case "schedule":
          return scheduleTool(input);
        case "policy":
          return { ...policy(), settingsFile: policyFile(), auditLog: auditFile(), home: os.homedir(), platform: process.platform };
        default:
          throw new Error(`Unknown local action: ${action}`);
      }
    })();
    audit(action, detailFor(action, input), true);
    return { ok: true, ...result };
  } catch (error) {
    audit(action, `${detailFor(action, input)} — ${error.message}`, false);
    throw error;
  }
}

module.exports = {
  configure,
  policy,
  savePolicy,
  reloadPolicy,
  policyFile,
  auditFile,
  runLocal,
  killAllProcesses,
  expandHome,
  // Scheduling: the store and the clock live here, the ticker lives in the app.
  scheduleFile,
  readSchedules,
  dueSchedules,
  describeCadence,
};
