/**
 * Nexora Desktop — MCP server over stdio.
 *
 * The same local workspace Nexora's own agent uses (`local-tools.js`), offered
 * to any MCP client: Claude Desktop, Claude Code, Cursor. One implementation,
 * one policy file, one audit log — the tools do not drift between hosts, and
 * turning local tools off in Nexora turns them off here too.
 *
 * It runs as a bare Node process (Electron with ELECTRON_RUN_AS_NODE=1, so the
 * installed app needs no separate runtime) and speaks JSON-RPC 2.0 as
 * newline-delimited JSON on stdin/stdout. No SDK: the protocol surface an MCP
 * tool server actually needs is initialize, tools/list and tools/call, and a
 * dependency-free file can be shipped inside app.asar unchanged.
 *
 * STDOUT IS THE PROTOCOL. Anything printed there that is not a JSON-RPC message
 * kills the connection — every diagnostic goes to stderr.
 *
 * Permission model: the host asks. Claude Desktop shows its own approval prompt
 * per call, so `confirm` here returns true rather than putting a second dialog
 * behind a window the user may not be looking at. The guardrails that are not
 * about consent — workspace scoping, blocked commands, the audit log — still
 * apply, because they live in local-tools.
 */

const local = require("./local-tools");

let VERSION = "0";
try {
  VERSION = String(require("./package.json").version || VERSION);
} catch {
  // Running from a copy without its package.json: the version is cosmetic.
}

// Newest first. We answer in the client's dialect when we know it, which is how
// a 2024-11-05 client and a 2025-06-18 client both get a working session.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Nexora Desktop's local workspace: files, search, and long-lived processes on this Mac.",
  "",
  "Find before you read: `search` with mode:\"content\" locates the lines, then read that file around them. Reading whole trees to look for a string is the slow way.",
  "Edit surgically: `edit_file` replaces one exact block you quote. It refuses rather than guessing — a wrong occurrence count or a near-miss comes back with the file's actual text marked up. Rewrite a whole file only when you mean to.",
  "Long writes truncate. Write in chunks of ~50 lines, continuing with mode:\"append\".",
  "`run_command` is one shot with an exit code. For anything that stays alive — a REPL, a dev server, an interactive installer — use `process`, which keeps the session and lets you send input to it.",
  "Paths may be scoped. If the user has set workspace folders, everything outside them is refused; `workspace_info` says which folders those are.",
].join("\n");

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "read_file",
    action: "read",
    description:
      "Read a file, or a window of its lines. Images come back as images. A negative offset counts from the end, which is how you tail a log. Set isUrl:true to fetch a URL and get it as text instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or ~/… . With isUrl:true, an http(s) URL." },
        offset: { type: "number", description: "Starting line (0-based). Negative counts back from the end." },
        length: { type: "number", description: "How many lines to return. Defaults to the configured read limit." },
        isUrl: { type: "boolean", description: "Treat path as a URL to fetch." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_multiple_files",
    action: "readMany",
    description: "Read several files in one call (up to 25). Each gets a share of the output budget — use it to survey, then read the interesting one on its own.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Paths to read." },
        length: { type: "number", description: "Max lines per file." },
      },
      required: ["paths"],
    },
  },
  {
    name: "write_file",
    action: "write",
    description:
      "Write a file, creating parent folders as needed. mode:\"rewrite\" replaces it, mode:\"append\" adds to the end. Keep each call to ~50 lines and append the rest: long single writes are where content gets silently truncated.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["rewrite", "append"], description: "Defaults to rewrite." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    action: "edit",
    description:
      "Replace one exact block of text. Quote oldText exactly as it appears, including indentation. If it appears more than once, pass expected with the count. No exact match returns the closest block with the differences marked instead of editing the nearly-right place.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "The exact text to replace." },
        newText: { type: "string", description: "What to put in its place. Empty string deletes it." },
        expected: { type: "number", description: "How many occurrences you mean to change. Defaults to 1." },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "list_directory",
    action: "list",
    description: "List a folder as a tree, up to 4 levels deep. Skips node_modules, .git and friends past the first level.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Defaults to the home folder." },
        depth: { type: "number", description: "1–4. Defaults to 1." },
        hidden: { type: "boolean", description: "Include dotfiles." },
      },
    },
  },
  {
    name: "file_info",
    action: "info",
    description: "Size, kind, permissions, line count and timestamps for one path — without reading it.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search",
    action: "search",
    description:
      "Find lines by content (mode:\"content\", the default) or files by name (mode:\"files\"). Uses ripgrep when it is installed and a bounded walk otherwise; either way it reports when it stopped early rather than implying the tree held nothing more.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Literal text by default. Set literal:false for a regular expression." },
        path: { type: "string", description: "Folder to search under. Defaults to the home folder — narrow it." },
        mode: { type: "string", enum: ["content", "files"] },
        glob: { type: "string", description: "Restrict to matching files, e.g. \"*.ts\"." },
        literal: { type: "boolean", description: "False to treat pattern as a regex." },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "number", description: "1–1000. Defaults to 100." },
        timeoutMs: { type: "number", description: "1000–60000. Defaults to 15000." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "move_file",
    action: "move",
    description: "Move or rename a file or folder. Refuses to clobber an existing destination unless overwrite is true. Works across volumes.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" }, overwrite: { type: "boolean" } },
      required: ["from", "to"],
    },
  },
  {
    name: "create_directory",
    action: "mkdir",
    description: "Create a folder, including any missing parents.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "delete_path",
    action: "delete",
    description: "Delete a file or an empty-or-not folder, permanently — this is not the Trash. Refuses the home folder and top-level paths.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "run_command",
    action: "shell",
    description:
      "Run one shell command in zsh and wait for it to finish. Returns exit code, stdout and stderr. For anything that keeps running or expects input, use `process` instead — this one will just hit its timeout.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Defaults to the home folder." },
        timeoutMs: { type: "number", description: "1000–600000. Defaults to 120000." },
      },
      required: ["command"],
    },
  },
  {
    name: "process",
    action: "process",
    description:
      "Long-lived processes. op:\"start\" launches one and returns its first output plus a pid; \"input\" sends a line to it and returns the reply; \"read\" collects whatever it has produced since last time; \"kill\" stops it; \"list\" shows what is running. Each call returns when the output goes quiet, so a REPL answers instead of hanging.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["start", "input", "read", "kill", "list"] },
        command: { type: "string", description: "For start." },
        cwd: { type: "string", description: "For start. Defaults to the home folder." },
        pid: { type: "number", description: "For input, read and kill." },
        text: { type: "string", description: "For input. A newline is appended." },
        timeoutMs: { type: "number", description: "How long to wait for output before returning." },
      },
      required: ["op"],
    },
  },
  {
    name: "schedule",
    action: "schedule",
    description:
      "Queue work for Nexora Desktop to do later, on a cadence: op 'list', 'add' (goal + every), 'remove', 'enable', 'disable', or 'run' (queue it for the next minute). " +
      "Nexora's own agent runs these — this server only keeps the list — so write the goal as a complete instruction to a capable assistant. Tasks fire only while Nexora Desktop is open.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "add", "remove", "enable", "disable", "run"] },
        goal: { type: "string", description: "For 'add': what the agent should do, stated in full." },
        every: {
          type: "string",
          description: 'For \'add\': "every 30 minutes", "hourly", "daily at 9am", "weekdays at 08:30", "every monday at 17:00" or "once at 2026-08-05 09:00".',
        },
        id: { type: "string", description: "The task id, for every op except list and add." },
      },
      required: ["op"],
    },
  },
  {
    name: "workspace_info",
    action: "policy",
    description: "What this server is allowed to do: workspace folders, blocked commands, output limits, and where the settings and audit log live.",
    inputSchema: { type: "object", properties: {} },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Scalars as `key: value` lines, objects as JSON — nothing the tool returned is dropped. */
function summarize(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : value}`)
    .join("\n");
}

function renderText(name, result) {
  const { ok, image, content, ...rest } = result;

  if (name === "run_command") {
    const head = `exit ${rest.exitCode}${rest.timedOut ? " (timed out)" : ""} — ${rest.cwd}`;
    const body = [rest.stdout, rest.stderr ? `[stderr]\n${rest.stderr}` : ""].filter(Boolean).join("\n");
    return `${head}\n\n${body || "(no output)"}`;
  }

  const meta = summarize(rest);
  if (typeof content === "string") return meta ? `${meta}\n\n${content}` : content;
  if (image) return meta;
  return meta || "done";
}

function toResult(name, result) {
  const blocks = [];
  if (result.image) blocks.push({ type: "image", data: result.image.dataBase64, mimeType: result.image.mediaType });
  const text = renderText(name, result);
  if (text) blocks.push({ type: "text", text });
  // edit_file reports a failed match in the payload rather than by throwing, so
  // the model gets the marked-up diff — but it is still a failure, and saying so
  // is what stops it treating the edit as applied.
  return { content: blocks, isError: Boolean(result.error) };
}

async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const result = await local.runLocal(tool.action, args && typeof args === "object" ? args : {}, {
      confirm: async () => true, // The MCP host owns the approval prompt.
    });
    return toResult(name, result);
  } catch (error) {
    return { content: [{ type: "text", text: String(error?.message || error) }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const asked = String(params?.protocolVersion || "");
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nexora-desktop", title: "Nexora Desktop", version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case "tools/call": {
      const name = String(params?.name || "");
      reply(id, await callTool(name, params?.arguments));
      return;
    }
    // Not advertised, but some clients probe anyway; an empty list is a kinder
    // answer than an error in their log.
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
  }
}

function dispatch(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, "Parse error");
    return;
  }
  // Batches were dropped in the 2025-06-18 spec but older clients still send them.
  const items = Array.isArray(request) ? request : [request];
  for (const item of items) {
    Promise.resolve(handle(item)).catch((error) => {
      if (item?.id !== undefined && item?.id !== null) fail(item.id, -32603, String(error?.message || error));
      else process.stderr.write(`nexora-mcp: ${error?.message || error}\n`);
    });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--data-dir");
  const dataDir = flag >= 0 ? argv[flag + 1] : process.env.NEXORA_DATA_DIR;
  // Same folder Nexora Desktop uses by default, so both hosts read one policy
  // file and append to one audit log.
  local.configure({ ...(dataDir ? { dataDir } : {}), host: "mcp" });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatch(line);
      index = buffer.indexOf("\n");
    }
  });

  const goodbye = () => {
    // Nothing this server started outlives the client that asked for it.
    local.killAllProcesses();
    process.exit(0);
  };
  process.stdin.on("close", goodbye);
  process.stdin.on("end", goodbye);
  process.on("SIGTERM", goodbye);
  process.on("SIGINT", goodbye);

  process.on("uncaughtException", (error) => {
    // A single bad call must not take the session down with it.
    process.stderr.write(`nexora-mcp: uncaught ${error?.stack || error}\n`);
  });

  process.stderr.write(`nexora-mcp ${VERSION} ready (${TOOLS.length} tools)\n`);
}

main();
