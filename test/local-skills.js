/**
 * The skills action in `local-tools.js`: the catalogue of written procedures
 * this machine already has, read the same way Claude Code reads it.
 *
 * Plain Node, no Electron — the module deliberately imports none, and these
 * assertions are about a filesystem scan and a permission gate, not a window.
 *
 * HOME is pointed at a temp tree for the duration, because the roots this scans
 * are ~/.claude/skills and ~/.claude/plugins: without that, the assertions would
 * be counting whatever the developer happens to have installed.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-skills-"));
const home = path.join(root, "home");
const personal = path.join(home, ".claude", "skills");
const plugins = path.join(home, ".claude", "plugins");
const custom = path.join(root, "custom");
const dataDir = path.join(root, "data");

// Before the require: dataDir is resolved off HOME at module load.
const REAL_HOME = process.env.HOME;
process.env.HOME = home;
fs.mkdirSync(dataDir, { recursive: true });

const local = require("../local-tools");

function writeSkill(dir, frontmatter, body = "## Steps\n1. Do the thing.\n") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}`);
  return file;
}

writeSkill(path.join(personal, "refund"), "name: refund-a-customer\ndescription: Issue a refund on a paid order.");
writeSkill(path.join(personal, "deploy"), 'name: "ship-a-release"\ndescription: "Cut a release and publish it."');
// Nested a level down, and with no frontmatter at all — the folder name is the
// fallback, which is how a hand-made skill still shows up.
fs.mkdirSync(path.join(personal, "team", "triage"), { recursive: true });
fs.writeFileSync(path.join(personal, "team", "triage", "SKILL.md"), "Sort the inbox by blast radius.\n");
writeSkill(path.join(plugins, "acme", "skills", "invoice"), "name: chase-an-invoice\ndescription: Chase a late invoice.");

local.configure({ dataDir });
local.resetSkillCache();

/** runLocal with consent granted, recording what the dialog was asked for. */
function run(action, input, answer = true) {
  const asked = [];
  const confirm = async (capability, detail) => {
    asked.push({ capability, detail });
    return answer;
  };
  return { asked, result: local.runLocal(action, input, { confirm }) };
}

const names = (out) => out.skills.map((s) => s.name);

test("list finds every SKILL.md under the well-known roots", async () => {
  const { asked, result } = run("skills", { op: "list" });
  const out = await result;
  assert.equal(out.ok, true);
  assert.equal(out.count, 4);
  assert.deepEqual(names(out), ["chase-an-invoice", "refund-a-customer", "ship-a-release", "triage"]);

  const byName = new Map(out.skills.map((s) => [s.name, s]));
  assert.equal(byName.get("refund-a-customer").description, "Issue a refund on a paid order.");
  assert.equal(byName.get("refund-a-customer").source, "personal");
  // Quoted frontmatter values arrive unquoted.
  assert.equal(byName.get("ship-a-release").description, "Cut a release and publish it.");
  // No frontmatter: the folder name and the opening line stand in.
  assert.match(byName.get("triage").description, /blast radius/);
  // A plugin's skills are found however deep the plugin buries them.
  assert.equal(byName.get("chase-an-invoice").source, "plugin");
  // Browsing the catalogue asks for nothing.
  assert.deepEqual(asked, []);
});

test("the listing omits the body — a catalogue is names, not instructions", async () => {
  const out = await run("skills", { op: "list" }).result;
  for (const skill of out.skills) {
    assert.equal(skill.content, undefined);
    assert.equal(skill.path, undefined);
  }
});

test("load returns the whole SKILL.md, and asks to read first", async () => {
  const { asked, result } = run("skills", { op: "load", name: "refund-a-customer" });
  const out = await result;
  assert.equal(out.ok, true);
  assert.equal(out.name, "refund-a-customer");
  assert.match(out.content, /^---\nname: refund-a-customer/);
  assert.match(out.content, /Do the thing/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].capability, "read");
  assert.match(asked[0].detail, /refund-a-customer/);
});

test("a refused dialog means no instructions come back", async () => {
  await assert.rejects(run("skills", { op: "load", name: "refund-a-customer" }, false).result, /Permission denied/);
});

test("an unknown skill names the way to find the real ones", async () => {
  await assert.rejects(run("skills", { op: "load", name: "not-a-skill" }).result, /Unknown skill: not-a-skill[\s\S]*op:'list'/);
});

test("load without a name is refused rather than guessed at", async () => {
  await assert.rejects(run("skills", { op: "load" }).result, /name is required/);
});

test("an unknown op says which ops exist", async () => {
  await assert.rejects(run("skills", { op: "install" }).result, /Unknown skills op: install/);
});

test("a name found twice keeps the earlier root — the user's own copy wins", async () => {
  writeSkill(path.join(custom, "refund"), "name: refund-a-customer\ndescription: The operator's own version.");
  process.env.NEXORA_SKILLS_DIRS = custom;
  local.resetSkillCache();
  try {
    const out = await run("skills", { op: "list" }).result;
    const refund = out.skills.find((s) => s.name === "refund-a-customer");
    assert.equal(refund.description, "The operator's own version.");
    assert.equal(refund.source, "custom");
    assert.equal(out.count, 4, "the shadowed copy is replaced, not added");
  } finally {
    delete process.env.NEXORA_SKILLS_DIRS;
    local.resetSkillCache();
  }
});

test("the scan is cached, and refresh:true is what breaks the cache", async () => {
  await run("skills", { op: "list" }).result; // prime

  writeSkill(path.join(personal, "late"), "name: added-after-the-scan\ndescription: Written a moment ago.");
  const stale = await run("skills", { op: "list" }).result;
  assert.equal(stale.count, 4, "a 60s cache is the point — the new folder should not appear yet");

  const fresh = await run("skills", { op: "list", refresh: true }).result;
  assert.equal(fresh.count, 5);
  assert.ok(names(fresh).includes("added-after-the-scan"));

  fs.rmSync(path.join(personal, "late"), { recursive: true, force: true });
  local.resetSkillCache();
});

test("a workspace folder's own .claude/skills counts as the project's", async () => {
  const project = path.join(root, "project");
  writeSkill(path.join(project, ".claude", "skills", "release"), "name: cut-the-tag\ndescription: Tag and push.");
  local.savePolicy({ allowedDirectories: [project] });
  local.resetSkillCache();
  try {
    const out = await run("skills", { op: "list" }).result;
    const project_skill = out.skills.find((s) => s.name === "cut-the-tag");
    assert.ok(project_skill, "a skill in the workspace folder should be listed");
    assert.equal(project_skill.source, "project");
  } finally {
    local.savePolicy({ allowedDirectories: [] });
    local.resetSkillCache();
  }
});

test("skills stay readable when the workspace is narrowed elsewhere", async () => {
  // The scope exists to keep file tools inside folders the user picked. Skills
  // live in ~/.claude, which is never one of them, so a narrowed workspace must
  // not empty the catalogue — while a plain read of the same file stays refused.
  const project = path.join(root, "elsewhere");
  fs.mkdirSync(project, { recursive: true });
  local.savePolicy({ allowedDirectories: [project] });
  local.resetSkillCache();
  try {
    const out = await run("skills", { op: "list" }).result;
    assert.ok(out.count >= 4, "narrowing the workspace should not hide installed skills");

    const loaded = await run("skills", { op: "load", name: "refund-a-customer" }).result;
    assert.match(loaded.content, /Do the thing/);

    await assert.rejects(
      run("read", { path: loaded.path }).result,
      /outside the Nexora workspace/,
      "the same file through the file tools is still scoped",
    );
  } finally {
    local.savePolicy({ allowedDirectories: [] });
    local.resetSkillCache();
  }
});

test("switching local tools off switches skills off too", async () => {
  local.savePolicy({ enabled: false });
  try {
    await assert.rejects(run("skills", { op: "list" }).result, /switched off/);
  } finally {
    local.savePolicy({ enabled: true });
  }
});

test("every call lands in the audit log", async () => {
  await run("skills", { op: "load", name: "refund-a-customer" }).result;
  const log = fs.readFileSync(path.join(dataDir, "local-tools.log"), "utf8").trim().split("\n");
  const last = JSON.parse(log[log.length - 1]);
  assert.equal(last.action, "skills");
  assert.equal(last.ok, true);
  assert.match(last.detail, /refund-a-customer/);
});

test.after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});
