/**
 * agent-desktop and agent-browser behind one `run(cli, command, args)`.
 *
 * The binaries are faked with tiny shell scripts, so what is pinned here is
 * ours: which commands are refused and why, how arguments are checked, that
 * stdin text never lands in argv, that a screenshot comes back as an image,
 * how output is capped and errors worded, and the order the binary is looked
 * up in. The CLIs' own behaviour is theirs to test.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-agent-clis-"));
const home = path.join(root, "home");
const dataDir = path.join(root, "data");
const REAL_HOME = process.env.HOME;
process.env.HOME = home;
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const local = require("../local-tools");
local.configure({ dataDir });
const clis = require("../agent-clis");

// PNG magic followed by filler: big enough to count as a picture, not a token.
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(900, 0x41)]);

function fakeBinary(name, script) {
  const file = path.join(root, "bin", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

// agent-desktop prints one JSON envelope; `screenshot` without PATH carries base64.
const desktopBin = fakeBinary(
  "agent-desktop",
  `
cmd="$1"; shift
case "$cmd" in
  --version) echo "agent-desktop 9.9.9"; exit 0 ;;
  status) echo '{"version":"2.6","ok":true,"command":"status","data":{"platform":"macos","permissions":{"accessibility":{"state":"granted"}}}}'; exit 0 ;;
  screenshot) echo '{"version":"2.6","ok":true,"command":"screenshot","data":{"format":"png","png_base64":"${PNG.toString("base64")}"}}'; exit 0 ;;
  type) text=$(cat); printf '{"ok":true,"command":"type","data":{"argv":"%s","stdin":"%s"}}\\n' "$*" "$text"; exit 0 ;;
  slow) sleep 5; echo '{"ok":true}'; exit 0 ;;
  big) i=0; while [ $i -lt 3000 ]; do echo "line $i of a very long envelope that goes on and on"; i=$((i+1)); done; exit 0 ;;
  fail) echo '{"version":"2.6","ok":false,"command":"fail","error":{"code":"STALE_REF","message":"take a new snapshot","disposition":{"retry":"safe"}}}'; echo "boom on stderr" >&2; exit 1 ;;
  *) printf '{"ok":true,"command":"%s","data":{"argv":"%s"}}\\n' "$cmd" "$*"; exit 0 ;;
esac`
);

// agent-browser prints text; `screenshot` prints where it saved the file.
const browserBin = fakeBinary(
  "agent-browser",
  `
cmd="$1"; shift
case "$cmd" in
  --version) echo "agent-browser 0.0.1"; exit 0 ;;
  snapshot) echo '- link "Learn more" [ref=e1]'; exit 0 ;;
  screenshot) out="\${1:-${root}/shot-\$\$.png}"; printf '%s' '${PNG.toString("base64")}' | base64 -d > "$out"; echo "Screenshot saved to $out"; exit 0 ;;
  fill) text=$(cat); echo "filled $* with <$text>"; exit 0 ;;
  open) echo "Error: Chrome for Testing is not installed. Run: agent-browser install" >&2; exit 1 ;;
  *) echo "ran $cmd $*"; exit 0 ;;
esac`
);

const env = { NEXORA_AGENT_DESKTOP_BIN: desktopBin, NEXORA_AGENT_BROWSER_BIN: browserBin };
const yes = async () => true;
const run = (cli, command, args, options = {}) => clis.run(cli, command, args, { confirm: yes, env, searchPath: [], bundledRoots: [], ...options });

test("the binary is found through the explicit env path first, then PATH-like dirs, and reported as missing otherwise", () => {
  assert.equal(clis.resolveBinary("desktop", { env, searchPath: [], bundledRoots: [] }).path, desktopBin);
  assert.equal(clis.resolveBinary("desktop", { env, searchPath: [], bundledRoots: [] }).source, "env");
  const viaDir = clis.resolveBinary("desktop", { env: {}, searchPath: [path.join(root, "bin")], bundledRoots: [] });
  // A PATH hit is handed back resolved, so a launcher or shim stands in for the native binary beside it.
  assert.equal(viaDir.path, fs.realpathSync(desktopBin));
  assert.equal(viaDir.source, "path");
  assert.equal(clis.resolveBinary("desktop", { env: {}, searchPath: [], bundledRoots: [] }), undefined);
  // A dead explicit path does not stop the search.
  assert.equal(clis.resolveBinary("browser", { env: { NEXORA_AGENT_BROWSER_BIN: "/nope/agent-browser" }, searchPath: [path.join(root, "bin")], bundledRoots: [] }).path, fs.realpathSync(browserBin));
  // The copy shipped with the app comes before PATH.
  const bundled = clis.resolveBinary("desktop", { env: {}, searchPath: [path.join(root, "bin")], bundledRoots: [path.join(__dirname, "..", "node_modules")] });
  assert.equal(bundled.source, "bundled");
  assert.match(bundled.path, /node_modules\/agent-desktop\/bin\/agent-desktop$/);
});

test("a missing binary is a refusal that says how to install, not a thrown error", async () => {
  const out = await clis.run("browser", "snapshot", ["-i"], { confirm: yes, env: {}, searchPath: [], bundledRoots: [] });
  assert.equal(out.ok, false);
  assert.equal(out.isError, true);
  assert.match(out.content, /agent-browser is not installed/);
  assert.match(out.content, /npm install -g agent-browser/);
});

test("a command is passed through as argv and the envelope comes back verbatim", async () => {
  const out = await run("desktop", "snapshot", ["--app", "Finder", "-i", "--compact"]);
  assert.equal(out.ok, true);
  assert.equal(out.isError, undefined);
  assert.equal(out.exitCode, 0);
  assert.equal(out.cli, "desktop");
  assert.equal(out.command, "snapshot");
  assert.equal(JSON.parse(out.content).data.argv, "--app Finder -i --compact");
  assert.ok(out.durationMs >= 0);
});

test("the refuse lists and the command-name rule are enforced before anything runs", async () => {
  for (const [cli, command] of [
    ["desktop", "mcp"],
    ["desktop", "key-down"],
    ["browser", "mcp"],
    ["browser", "install"],
    ["browser", "auth"],
    ["browser", "confirm"],
    ["browser", "plugin"]
  ]) {
    const out = await run(cli, command, []);
    assert.equal(out.isError, true, `${cli} ${command}`);
    assert.match(out.content, new RegExp(`\`${command}\` is refused`), `${cli} ${command}`);
  }
  const weird = await run("desktop", "snapshot; rm -rf /", []);
  assert.equal(weird.isError, true);
  assert.match(weird.content, /subcommand name/);
  const upper = await run("desktop", "Snapshot", []);
  assert.equal(upper.isError, true);
});

test("arguments are checked: strings only, bounded in count and length, no NUL", async () => {
  const tooMany = await run("desktop", "snapshot", new Array(65).fill("-i"));
  assert.match(tooMany.content, /at most 64 arguments/);
  const tooLong = await run("desktop", "snapshot", ["x".repeat(5000)]);
  assert.match(tooLong.content, /4096/);
  const nul = await run("desktop", "snapshot", ["a\u0000b"]);
  assert.match(nul.content, /NUL/);
  const notStrings = await run("desktop", "snapshot", [1, 2]);
  assert.equal(notStrings.isError, true);
  const unknownCli = await clis.run("phone", "snapshot", [], { confirm: yes, bundledRoots: [] });
  assert.equal(unknownCli.isError, true);
  assert.match(unknownCli.content, /Unknown agent CLI/);
});

test("stdin text is piped, never placed in argv, and --stdin is added once for the text commands", async () => {
  const out = await run("desktop", "type", ["@s1:e2"], { stdin: "hunter2" });
  const data = JSON.parse(out.content).data;
  assert.equal(data.stdin, "hunter2");
  assert.equal(data.argv, "@s1:e2 --stdin");
  const already = await run("desktop", "type", ["@s1:e2", "--stdin"], { stdin: "x" });
  assert.equal(JSON.parse(already.content).data.argv, "@s1:e2 --stdin");
  // agent-browser has no --stdin: text travels as an argument, stdin is only piped.
  const fill = await run("browser", "fill", ["@e2", "secret value"], { stdin: "ignored" });
  assert.match(fill.content, /^filled @e2 secret value with <ignored>/);
  const huge = await run("desktop", "type", ["@s1:e2"], { stdin: "x".repeat(70_000) });
  assert.equal(huge.isError, true);
  assert.match(huge.content, /stdin/);
});

test("a desktop screenshot's base64 becomes an image block and leaves the envelope", async () => {
  const out = await run("desktop", "screenshot", ["--app", "Finder"]);
  assert.equal(out.ok, true);
  assert.equal(out.image.mediaType, "image/png");
  assert.equal(Buffer.from(out.image.dataBase64, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.doesNotMatch(out.content, /iVBORw0KGgo/);
  assert.match(out.content, /"png_base64":"<image/);
});

test("a browser screenshot is read from the path the CLI prints and returned as an image", async () => {
  const out = await run("browser", "screenshot", []);
  assert.equal(out.ok, true);
  assert.equal(out.image.mediaType, "image/png");
  assert.match(out.content, /Screenshot saved to/);
  const where = path.join(root, "custom.png");
  const named = await run("browser", "screenshot", [where]);
  assert.equal(named.image.mediaType, "image/png");
  assert.ok(fs.existsSync(where), "a path the model chose is left in place");
});

test("a failing command keeps the envelope, appends the stderr tail and the exit code, and is an error", async () => {
  const out = await run("desktop", "fail", []);
  assert.equal(out.ok, false);
  assert.equal(out.isError, true);
  assert.equal(out.exitCode, 1);
  assert.match(out.content, /STALE_REF/);
  assert.match(out.content, /\[stderr\] boom on stderr/);
  assert.match(out.content, /\[exit 1\]/);
});

test("a browser that is not installed yet is explained in the host's own words", async () => {
  const out = await run("browser", "open", ["example.com"]);
  assert.equal(out.isError, true);
  assert.match(out.content, /Chrome for Testing is not installed/);
  assert.match(out.content, /Install Browser for Agent Browser/);
});

test("output is capped and says so", async () => {
  const out = await run("desktop", "big", []);
  assert.ok(out.content.length <= 100_000 + 200, String(out.content.length));
  assert.match(out.content, /truncated/);
});

test("a timeout kills the command and reports it", async () => {
  const out = await run("desktop", "slow", [], { timeoutMs: 1000 });
  assert.equal(out.isError, true);
  assert.match(out.content, /timed out after 1000 ms/);
});

test("permission goes through confirm with the capability and the command line, and a refusal is final", async () => {
  const asked = [];
  const confirm = async (capability, detail) => {
    asked.push({ capability, detail });
    return false;
  };
  const out = await clis.run("desktop", "type", ["@s1:e8"], { confirm, env, searchPath: [], bundledRoots: [], stdin: "x" });
  assert.equal(out.isError, true);
  assert.match(out.content, /Permission denied/);
  assert.deepEqual(asked, [{ capability: "agentDesktop", detail: "agent-desktop type @s1:e8 --stdin (+ 1 chars on stdin)" }]);
  const browserAsk = [];
  await clis.run("browser", "snapshot", ["-i"], { confirm: async (c, d) => (browserAsk.push({ c, d }), true), env, searchPath: [], bundledRoots: [] });
  assert.deepEqual(browserAsk, [{ c: "agentBrowser", d: "agent-browser snapshot -i" }]);
});

test("status reports both CLIs: where they were found, their version, and desktop permissions", async () => {
  const status = await clis.status({ env, searchPath: [], bundledRoots: [] });
  assert.equal(status.desktop.found, true);
  assert.equal(status.desktop.version, "agent-desktop 9.9.9");
  assert.equal(status.desktop.permissions.accessibility.state, "granted");
  assert.equal(status.browser.found, true);
  assert.equal(status.browser.version, "agent-browser 0.0.1");
  const none = await clis.status({ env: {}, searchPath: [], bundledRoots: [] });
  assert.equal(none.desktop.found, false);
  assert.match(none.desktop.install, /npm install -g agent-desktop/);
});

test("the tool definitions carry the shared contract", () => {
  const names = clis.TOOL_DEFS.map((t) => t.name);
  assert.deepEqual(names, ["agent_desktop", "agent_browser"]);
  for (const def of clis.TOOL_DEFS) {
    assert.deepEqual(def.inputSchema.required, ["command"]);
    assert.deepEqual(Object.keys(def.inputSchema.properties), ["command", "args", "stdin", "timeoutMs"]);
    assert.match(def.description, /skills get/);
  }
});

test.after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});
