/**
 * Word, Excel, PowerPoint and zip files read through the local tools.
 *
 * The web chat and Nexora Code already turn these into text when they are
 * attached; here the same shared readers (`documents/`, compiled from the
 * runtime's `src/documents`) sit behind `read`, `readMany` and `info`, so an
 * Office file on the user's disk comes back as prose, tables and slides
 * instead of "Binary file — not shown". The refusals matter as much as the
 * text: an old binary .doc says how to convert it, and a bad archive names the
 * reason, both as errors the model can pass on.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-documents-"));
const home = path.join(root, "home");
const dataDir = path.join(root, "data");

// Before the require: dataDir is resolved off HOME at module load.
const REAL_HOME = process.env.HOME;
process.env.HOME = home;
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const local = require("../local-tools");
local.configure({ dataDir });

const fixtures = path.join(__dirname, "fixtures", "documents");
const docs = path.join(root, "docs");
fs.mkdirSync(docs, { recursive: true });
for (const name of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, name), path.join(docs, name));
// An "old" Office file is just the OLE2 magic with the legacy extension.
fs.writeFileSync(path.join(docs, "contract.doc"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
// A zip whose header lies about the method: not an archive the reader trusts.
fs.writeFileSync(path.join(docs, "broken.zip"), Buffer.from("PK\u0003\u0004 this is not really a zip archive at all"));
fs.writeFileSync(path.join(docs, "notes.txt"), "plain text stays plain\n");

/** runLocal with consent granted. */
function run(action, input) {
  return local.runLocal(action, input, { confirm: async () => true });
}

test("a .docx comes back as its text, with the line window the model asked for", async () => {
  const out = await run("read", { path: path.join(docs, "sample.docx") });
  assert.equal(out.ok, true);
  assert.equal(out.document, "docx");
  assert.equal(out.binary, undefined);
  assert.match(out.content, /Quarterly Plan/);
  assert.match(out.content, /Ship the upload feature in November\./);
  assert.match(out.content, /Item \| Owner/);
  assert.ok(out.totalLines >= 3, `totalLines ${out.totalLines}`);

  const tail = await run("read", { path: path.join(docs, "sample.docx"), offset: -1 });
  assert.equal(tail.firstLine, out.totalLines);
  assert.equal(tail.truncated, true);
});

test("a .xlsx is one TSV block per sheet, formulas included", async () => {
  const out = await run("read", { path: path.join(docs, "sample.xlsx") });
  assert.equal(out.document, "xlsx");
  assert.match(out.content, /## Budget/);
  assert.match(out.content, /Hosting\t1200\tCloud Run/);
  assert.match(out.content, /=SUM\(B2:B3\)/);
});

test("a .pptx is its slides in order, speaker notes included", async () => {
  const out = await run("read", { path: path.join(docs, "sample.pptx") });
  assert.equal(out.document, "pptx");
  assert.match(out.content, /## Slide 1: Nexora Uploads/);
  assert.match(out.content, /Notes: Mention the size limits\./);
});

test("a .zip is a tree plus its readable text files", async () => {
  const out = await run("read", { path: path.join(docs, "sample.zip") });
  assert.equal(out.document, "zip");
  assert.match(out.content, /Archive \*\*sample\.zip\*\*/);
  assert.ok(out.content.length > 1000, "the archive's text files are inlined");
});

test("an old binary .doc is refused with the conversion advice, not shown as bytes", async () => {
  await assert.rejects(run("read", { path: path.join(docs, "contract.doc") }), /save it as \.docx\/\.xlsx\/\.pptx/);
});

test("a corrupt archive is refused by name", async () => {
  await assert.rejects(run("read", { path: path.join(docs, "broken.zip") }), /broken\.zip/);
});

test("plain text and images are untouched by the document path", async () => {
  const out = await run("read", { path: path.join(docs, "notes.txt") });
  assert.equal(out.document, undefined);
  assert.equal(out.content, "plain text stays plain\n");
  assert.equal(out.totalLines, 2);
});

test("readMany gives a document its share like any text file", async () => {
  const out = await run("readMany", { paths: [path.join(docs, "notes.txt"), path.join(docs, "sample.docx")] });
  assert.match(out.content, /plain text stays plain/);
  assert.match(out.content, /Quarterly Plan/);
  assert.doesNotMatch(out.content, /Binary file/);
});

test("info names the document kind and does not count lines of a binary container", async () => {
  const out = await run("info", { path: path.join(docs, "sample.xlsx") });
  assert.equal(out.kind, "file");
  assert.equal(out.document, "xlsx");
  assert.equal(out.lines, undefined);
  const text = await run("info", { path: path.join(docs, "notes.txt") });
  assert.equal(text.document, undefined);
  assert.equal(text.lines, 2);
});

test.after(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});
