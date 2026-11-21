/**
 * The command guard, pinned to Nexora Code's parser.
 *
 * `command-guard.js` decides what an "Always Allow" may cover: a line it calls
 * simple can run without a dialog, under a key taken from its first words. It
 * is compiled from the extension's `localExec.ts`, and the extension keeps a
 * frozen oracle for exactly that code — the adversarial list its 1.14.1 review
 * ran, and every line of up to three tokens from the review's alphabet, with
 * the verdict, the words, the grant key and "asks every time" recorded for
 * each. This replays that oracle (`fixtures/commandOracle.json`, copied from
 * `nexora-vscode/src/fixtures/`) against the compiled copy, so the two cannot
 * drift apart quietly: a re-sync that moves a line fails here, and so does a
 * hand edit.
 *
 * The explicit list and the alphabet below are the extension's
 * (`src/commandOracle.test.ts`), verbatim. Never edit them here: re-copy them
 * with the fixture when the extension re-records.
 */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const guard = require("../command-guard");
const { commandKey, onceReason, parseSimpleCommand } = guard;

const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "commandOracle.json"), "utf8"));

// prettier-ignore
const explicit = [
  "a&&b", "a||b", "a;b", "a|b", "a|&b", "a&b", "a &", "a\nb", "a\rb", "a\r\nb", "a\\\nb", "a\\", "a\\\\", "\\", "a \\", "\\\n",
  "$(a)", "a $(b)", "a `b`", "a ${b}", "a $b", "a \"$b\"", "a \"`b`\"", "a \"$(b)\"", "a '$(b)'", "a \"\\$b\"", "a \"\\`b\\`\"", "a \\$b", "a \\`b\\`",
  "a <(b)", "a >(b)", "a <<EOF", "a <<<b", "a <<-EOF", "a >b", "a >>b", "a 2>b", "a 2>&1", "a &>b", "a &>>b", "a <b", "a >|b", "a 1>b", "a 10>b", "a>b", "a>&2", "a<&0", "a<>b", "a 2>>b", "a '2'>b", "a \\2>b", "a x2>b",
  "2>b", "2>b a", "2> b a", "1>&2", "0<a b", "9", "9 a", "12", "a 2", "a 2 b", "2 > b",
  "a 'b", "a \"b", "a $'b'", "a $\"b\"", "a $'\\n'", "a '", "a \"", "'", "\"", "''", "\"\"", "'' a", "a ''", "a '' b", "''''",
  "a #b", "#a", "a#b", "a # ; b", "A=1 a", "A=1", "A= a", "_A=1 a", "A1=2 a", "1A=2 a", "a A=1", "'A'=1 a", "A\\=1 a", "\"A=1\" a", "A+=1 a", "A[0]=1 a", "a=b=c d",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ=1 a", "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ=1 a", "A".repeat(5000) + "=1 a",
  "a {b,c}", "{a,b}", "a {b..c}", "a *", "a ?", "a [b]", "a ~", "~/a", "a ~b", "a ~+", "a !b", "!a", "a !!", "a ^b^c",
  "a\u00a0b", "a\u2003b", "a\u200bb", "a\u200b;b", "a\ufeffb", "\ufeffa", "a\u2028b", "a\u2029b", "a\u0085b", "a\vb", "a\fb", "a\tb", "a\t;b", "a\0b", "a\0;b", "a\x1bb", "a\x7fb", "a\u202eb", "a\uff1bb", "a\uff06\uff06b", "a\uff5cb",
  "a -- b", "a --", "-- a", "a -c b", "sh -c x", "bash -c 'x; y'", "node -e x", "python3 -c x", "python3.12 x", "/usr/bin/env a", "env a", "sudo a", "xargs a", "find . -exec a", "find . -name x", "fd -x a", "git -c a=b log",
  "a --eval=x", "a --exec=x", "a --command=x", "a /c x", "cmd /c x", "pwsh -Command x", "a -Command x", "a -command x", "a -C x", "a -E x", "NODE.EXE x", "Sh x", "/bin/SH x", "a\\b\\sh x", "./sh x", "sh", "'sh' x", "s\\h x", "\"s\"h x", "sh.exe", "sh.EXE x", "sh.exe.exe",
  "a ;", "; a", "a ;; b", "a & b", "a && ", "&& a", "| a", "a |", "(a)", "( a )", "a (b)", "a )", ") a", "a (", "{ a; }", "{ a }", "a }", "a $((1+1))", "a $[1]", "a $", "a $ b", "$", "a $?", "a $$", "a $!", "a $#", "a $@", "a $*", "a $-", "a $0", "a $1", "a \"$\"", "a \"$ \"", "a \"a$\"",
  "$(a) )", "a $(b) ; c", "a $(b)) c", "a $(b)(c)", "a >(b) )", "(a) $(b)", "a $(b) ) ; c", "a ) $(b)", "a $( ( b ) )", "a $(b) $(c))", "a \")\"", "a $(')')", "$(a))b", ")", "))", "a))", "$())", "$()", "<()", ">()", "a $()b",
  "a \\;b", "a \\; b", "a ';' b", "a \";\" b", "a '&&' b", "a \"|\" b", "a \\| b", "a '>' b", "a \\> b", "a \"<\" b", "a '(' b", "a \\( b", "a '`' b", "a '$' b", "a \\\nb", "a '\n' b", "a \"\n\" b", "a \"\\\nb\"",
  "", " ", "\t", "\u00a0", "\u200b", "a".repeat(200000), ("a ".repeat(50000)) + ";b", "a " + "'".repeat(100001), "a " + "\\".repeat(100001), "a " + "\\".repeat(100000),
  "a 2\\>b", "a 2'>'b", "2>", "a 2>", "a >", "a <", "a 2<", "22>>b", "a 2>>", "a 2>&", "a 2>|b", "a 2>(b)", "a 2<(b)", "2>(b)", "2<(b) a", "a 2<<b", "a 2<<<b", "a 2&>b", "a 2&", "a 2|b", "a 2;b", "a 2$b", "a 2`b`",
];

// prettier-ignore
const toks = ["a", "sh", "2", " ", "\t", "\n", "\r", ";", "&", "|", "<", ">", "(", ")", "`", "$", "{", "}", "'", "\"", "\\", "#", "=", "-c", "A=", "\u00a0", "\0", "~", "*"];
const DEPTH = 3;

function verdict(line) {
  const parsed = parseSimpleCommand(line);
  return { ok: parsed.ok, ...(parsed.ok ? { argv: parsed.argv } : {}), key: commandKey(line), asks: onceReason(line) !== undefined };
}

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** A line or a verdict as the fixture holds it: itself when short, a digest when it is one of the very long ones. */
const compact = (value) => {
  const json = JSON.stringify(value);
  return json.length > 240 ? { sha256: sha(json), length: json.length } : value;
};

/** Every line of up to `depth` tokens, grouped under its first two tokens. */
function generated() {
  const buckets = new Map();
  const walk = (prefix, depth) => {
    const bucket = JSON.stringify(prefix.slice(0, 2));
    const lines = buckets.get(bucket) ?? [];
    lines.push(prefix.join(""));
    buckets.set(bucket, lines);
    if (depth === 0) return;
    for (const token of toks) walk([...prefix, token], depth - 1);
  };
  walk([], DEPTH);
  return buckets;
}

test("the explicit adversarial lines parse exactly as Nexora Code recorded them: verdict, words, grant key, asks-every-time", () => {
  assert.equal(explicit.length, frozen.explicit.length, "the explicit list and the fixture were not copied together");
  const moved = [];
  frozen.explicit.forEach((entry, index) => {
    const line = compact(explicit[index]);
    const mine = compact(verdict(explicit[index]));
    if (JSON.stringify(line) !== JSON.stringify(entry.line)) moved.push(`#${index}: the line itself differs — ${JSON.stringify(entry.line)} here is ${JSON.stringify(line)}`);
    else if (JSON.stringify(mine) !== JSON.stringify(entry.verdict)) moved.push(`#${index} ${JSON.stringify(entry.line)}: recorded ${JSON.stringify(entry.verdict)}, here ${JSON.stringify(mine)}`);
  });
  assert.deepEqual(moved, [], "command-guard.js parses recorded lines differently from the extension's oracle");
  assert.ok(frozen.explicit.length >= 270);
});

test("every line of up to three tokens parses exactly as recorded", () => {
  assert.deepEqual(toks, frozen.generated.tokens, "the token alphabet is part of the oracle");
  assert.equal(DEPTH, frozen.generated.depth);
  let lines = 0;
  let simple = 0;
  const moved = [];
  for (const [bucket, members] of generated()) {
    const verdicts = members.map(verdict);
    lines += members.length;
    simple += verdicts.filter((v) => v.ok).length;
    if (sha(JSON.stringify(verdicts)) !== frozen.generated.buckets[bucket]) moved.push(bucket);
  }
  assert.equal(lines, frozen.generated.lines);
  assert.ok(lines > 25000);
  assert.deepEqual(moved, [], `lines under ${moved.length} two-token prefix(es) parse differently than recorded`);
  assert.equal(simple, frozen.generated.simple, "how many generated lines are simple commands");
});

test("the properties the oracle exists for, stated outright", () => {
  // Simple, sessionable, keyed on the first two words.
  assert.deepEqual(verdict("a b"), { ok: true, argv: ["a", "b"], key: "shell:a b", asks: false });
  assert.equal(commandKey("git push origin main"), "shell:git push");
  assert.equal(commandKey("node -i"), "shell:node");
  // A grant for `git` never covers another program that is merely called git.
  assert.equal(commandKey("/tmp/x/git push"), "shell:/tmp/x/git push");
  // Everything with structure asks every time — quotes are honoured, so a `;` inside one is not structure.
  for (const line of ["a&&b", "a;b", "a|b", "a $(b)", "a `b`", "a >b", "a 2>&1", "A=1 a", "a\nb", "a {b,c}", "{a,b}", "a }", "a\u00a0b", "a\vb", "a\0b", "a\u200bb", "a\u202eb", "\ufeffa"]) {
    assert.equal(verdict(line).ok, false, JSON.stringify(line));
    assert.equal(verdict(line).asks, true, JSON.stringify(line));
  }
  assert.deepEqual(parseSimpleCommand('git commit -m "fix; thing"'), { ok: true, argv: ["git", "commit", "-m", "fix; thing"] });
  // Simple to parse, but the program runs whatever it is handed: still asks.
  for (const line of ["sh -c x", "node -e x", "python3 x.py", "npx thing", "sudo a", "env a", "xargs a", "find . -exec a", "fd -x a", "git -c a=b log", "timeout 5 a", "docker run x", "make all", "osascript x"]) {
    assert.equal(verdict(line).ok, true, line);
    assert.equal(verdict(line).asks, true, line);
  }
  for (const line of ["git status", "npm test", "ls -la", "find . -name x"]) assert.equal(verdict(line).asks, false, line);
});

test("the reason is a plain sentence that names the operator or the program", () => {
  assert.equal(onceReason("cd app && npm test"), 'Chains commands with "&&" — this asks every time.');
  assert.equal(onceReason("cat a | grep b"), 'Pipes output with "|" — this asks every time.');
  assert.equal(onceReason("make 2> err.log"), 'Redirects output with "2>" — this asks every time.');
  assert.equal(onceReason("echo $(whoami)"), 'Uses a substitution ("$(…)") — this asks every time.');
  assert.equal(onceReason("sh -c 'rm x'"), 'Runs an interpreter ("sh -c") — this asks every time.');
  assert.equal(onceReason("sudo rm x"), 'Runs another command through "sudo" — this asks every time.');
  assert.equal(onceReason("find . {-exec,rm} {} +"), 'Uses brace expansion ("{…}") — this asks every time.');
  assert.equal(onceReason("ls\u00a0-la"), "Contains invisible or unusual characters — this asks every time.");
  assert.equal(onceReason("a | b && c > d"), 'Pipes output with "|", chains commands with "&&" and redirects output with ">" — this asks every time.');
});

test("the denylist reads a line as the shell will, not as it was quoted", () => {
  assert.equal(guard.blockedCommand("rm -rf /"), "rm -rf /");
  assert.equal(guard.blockedCommand("r\"m\" -rf '/'"), "rm -rf /");
  assert.equal(guard.blockedCommand('rm -rf "$HOME"'), "rm -rf ~");
  assert.equal(guard.blockedCommand("rm -rf ${HOME}/"), "rm -rf ~");
  assert.equal(guard.blockedCommand("rm -fr ~/*"), "rm -rf ~");
  assert.equal(guard.blockedCommand("rm -rf ~/project/build"), null);
  assert.equal(guard.blockedCommand("rm -rf ./dist"), null);
});

test("start-up files: the whole family, as paths", () => {
  for (const file of [
    "/Users/a/.zshrc", "/Users/a/.bashrc", "/Users/a/.profile", "/Users/a/.zshenv", "/Users/a/.bash_aliases", "/Users/a/.gitconfig",
    "/Users/a/.npmrc", "/Users/a/p/.envrc", "/Users/a/p/.tool-versions", "/Users/a/.config/fish/conf.d/x.fish", "/Users/a/.config/git/config",
    "/Users/a/.oh-my-zsh/custom/x.zsh", "/Users/a/.config/nvim/init.lua", "/Users/a/p/.husky/pre-commit",
    "/Users/a/p/.git/config", "/Users/a/p/.git/hooks/pre-commit", "/Users/a/p/.git/modules/sub/hooks/post-checkout",
  ]) {
    assert.equal(guard.isStartupFile(file), true, file);
  }
  for (const file of ["/Users/a/p/README.md", "/Users/a/p/src/zshrc.txt", "/Users/a/p/.vscode/settings.json", "/Users/a/p/.git/HEAD", "/Users/a/p/hooks/pre-commit"]) {
    assert.equal(guard.isStartupFile(file), false, file);
  }
});

test("output is scrubbed of what travels as a secret, and a private key withholds the whole of it", () => {
  assert.equal(guard.scrubOutput("curl -H 'Authorization: Bearer abc.def.ghi' x"), "curl -H 'Authorization: Bearer [redacted]' x");
  assert.equal(guard.scrubOutput("deploy --token=s3cr3tvalue --name app"), "deploy --token=[redacted] --name app");
  assert.equal(guard.scrubOutput("git clone https://user:hunter2@example.com/r.git"), "git clone https://user:[redacted]@example.com/r.git");
  assert.equal(guard.scrubOutput("GITHUB_TOKEN=abc123 PATH=/bin"), "GITHUB_TOKEN=[redacted] PATH=/bin");
  assert.match(guard.scrubOutput(`token ghp_${"a1B2".repeat(9)} end`), /^token \[redacted secret\] end$/);
  // A flag that merely contains the word takes no value and is left alone.
  assert.equal(guard.scrubOutput("gh auth login --with-token"), "gh auth login --with-token");
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n";
  assert.equal(guard.scrubOutput(`before\n${pem}after`), "[output withheld: it contains a private key]");
  assert.equal(guard.scrubOutput("plain build output, 3 warnings"), "plain build output, 3 warnings");
});
