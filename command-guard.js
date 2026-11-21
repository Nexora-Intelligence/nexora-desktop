/**
 * Nexora Desktop — the command guard.
 *
 * What a shell command line is, as the permission gate needs to know it: its
 * words, every piece of shell structure in it, the key an "Always Allow" is
 * remembered under, why a line must ask every time, which files run on their
 * own at start-up, and how output is scrubbed of secrets before a model sees
 * it. These are Nexora Code's rules, so that the same line is treated the same
 * way in the IDE and in this app.
 *
 * NEVER EDITED BY HAND. This file is compiled from the Nexora Code extension —
 * `nexora-vscode/src/localExec.ts` at v1.16.0 (daeadf8): `baseOf`, the
 * start-up file table, and the whole "shell" section through `scrubOutput` —
 * the same way `documents/` is compiled from the extension's readers (see
 * `documents/SYNC.md` in the runtime). `test/command-guard.js` replays the
 * extension's frozen parser oracle (`test/fixtures/commandOracle.json`, copied
 * from `nexora-vscode/src/fixtures/`) against it, so a drift in either
 * direction fails a test rather than loosening a grant.
 *
 * To re-sync after the extension changes, from the directory that holds both
 * repos (the line numbers are the 1.16.0 ones — check them against the section
 * markers before trusting them):
 *
 *   EXT=$PWD/nexora-vscode; G=$(mktemp -d); mkdir -p "$G/documents"
 *   cp "$EXT"/src/documents/{zip,office,archive,index}.ts "$G/documents/"
 *   { echo 'import { scrubKeyMaterial } from "./documents/archive";'
 *     sed -n '303,305p;307,348p;613,1084p' "$EXT/src/localExec.ts"; } > "$G/command-guard.ts"
 *   (cd "$G" && "$EXT/node_modules/.bin/tsc" command-guard.ts --module commonjs --target es2022 \
 *     --moduleResolution node --lib es2022 --typeRoots "$EXT/node_modules/@types" --types node \
 *     --esModuleInterop --skipLibCheck --strict --declaration false --sourceMap false --outDir out)
 *   { sed -n '1,/^ \*\/$/p' nexora-desktop/command-guard.js; cat "$G/out/command-guard.js"; } > "$G/next.js"
 *   mv "$G/next.js" nexora-desktop/command-guard.js
 *   cp "$EXT/src/fixtures/commandOracle.json" nexora-desktop/test/fixtures/commandOracle.json
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASKS_EVERY_TIME = exports.CODE_FLAGS = exports.INDIRECT_PROGRAMS = exports.BLOCKED_COMMAND_PATTERNS = exports.UNUSUAL_CHARS = exports.STARTUP_DIRS = exports.STARTUP_FILES = void 0;
exports.isStartupFile = isStartupFile;
exports.describeStructure = describeStructure;
exports.scanCommand = scanCommand;
exports.parseSimpleCommand = parseSimpleCommand;
exports.normaliseCommand = normaliseCommand;
exports.blockedCommand = blockedCommand;
exports.commandKey = commandKey;
exports.indirectCommand = indirectCommand;
exports.onceReason = onceReason;
exports.scrubCommandSecrets = scrubCommandSecrets;
exports.scrubOutput = scrubOutput;
const archive_1 = require("./documents/archive");
function baseOf(path) {
    return path.slice(path.lastIndexOf("/") + 1);
}
/**
 * Files a shell, git or a tool chain reads or runs on its own, by name: a
 * line written there runs later, as the person, without anyone invoking it.
 * Shell start-up and logout files, readline's, git's, the package managers'
 * rc files (an `.npmrc` can point `registry` or a `script-shell` anywhere),
 * direnv's, the version managers', Python's start-up hook.
 */
exports.STARTUP_FILES = new Set([
    ".profile", ".bash_profile", ".bash_login", ".bash_logout", ".bashrc", ".bash_aliases",
    ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
    ".kshrc", ".cshrc", ".tcshrc", ".inputrc",
    ".gitconfig",
    ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs",
    ".envrc", ".tool-versions", ".mise.toml", ".python-startup"
]);
/**
 * Folders whose every file is read at start-up — as path segments, so
 * `conf.d` under fish and a sub-folder under `.zshrc.d` count. Editors'
 * home-level config (`.config/nvim`, `.vim`) is here because it is code that
 * runs when the editor opens; `.vscode/` and `.idea/` are not, because they
 * are a project's files. `.husky/` is a hooks folder a static check can
 * see; a `core.hooksPath` pointing elsewhere is not, so hooks under any
 * `.git` folder are matched separately below.
 */
exports.STARTUP_DIRS = [
    ".config/git", ".config/fish", ".bashrc.d", ".zshrc.d", ".zsh", ".oh-my-zsh/custom", ".config/nvim", ".vim", ".husky"
];
/**
 * Whether a path is one of the files above, a git config, or a hook under
 * any `.git` folder (the repository's, a worktree's, a submodule's under
 * `.git/modules/…`). Not credentials, so a read is fine; a write, an edit,
 * a move or a delete asks on its own, every time, under no grant.
 */
function isStartupFile(path) {
    const normalised = path.replace(/\\/g, "/");
    if (exports.STARTUP_FILES.has(baseOf(normalised)))
        return true;
    if (normalised.endsWith("/.git/config"))
        return true;
    if (/\/\.git\/(?:[^/]+\/)*hooks\/[^/]+$/.test(normalised))
        return true;
    return exports.STARTUP_DIRS.some((dir) => normalised.includes(`/${dir}/`));
}
/** The characters that give a line shell structure or a substitution when they stand outside single quotes. */
const CONTROL_CHARS = ";&|<>()`$";
const quoted = (tokens) => {
    const shown = tokens.map((token) => `"${token}"`);
    return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
};
/** What each kind of structure does, as the start of a sentence, naming the operators found. */
const STRUCTURE_PHRASE = {
    chain: (tokens) => `Chains commands with ${quoted(tokens)}`,
    background: (tokens) => `Runs a command in the background with ${quoted(tokens)}`,
    pipe: (tokens) => `Pipes output with ${quoted(tokens)}`,
    redirect: (tokens) => `Redirects output with ${quoted(tokens)}`,
    input: (tokens) => `Redirects input with ${quoted(tokens)}`,
    substitution: (tokens) => `Uses a substitution (${quoted(tokens)})`,
    variable: (tokens) => `Uses a shell variable (${quoted(tokens)})`,
    subshell: (tokens) => `Groups commands with ${quoted(tokens)}`,
    brace: (tokens) => `Uses brace expansion (${quoted(tokens)})`,
    unusual: () => "Contains invisible or unusual characters",
    lines: () => "Has more than one line",
    backslash: () => "Ends with a backslash",
    quote: () => "Has an unclosed quote",
    assignment: (tokens) => `Sets a variable in front of the command (${quoted(tokens)})`,
    empty: () => "Has no command"
};
/**
 * The findings as one plain sentence without its full stop: `Chains
 * commands with "&&" and pipes output with "|"`. Kinds in the order first
 * seen, each naming every operator of that kind once.
 */
function describeStructure(findings) {
    const byKind = new Map();
    for (const finding of findings) {
        const tokens = byKind.get(finding.kind) ?? [];
        if (!tokens.includes(finding.token))
            tokens.push(finding.token);
        byKind.set(finding.kind, tokens);
    }
    const phrases = [...byKind].map(([kind, tokens]) => STRUCTURE_PHRASE[kind](tokens));
    const rest = phrases.slice(1).map((phrase) => phrase.charAt(0).toLowerCase() + phrase.slice(1));
    const all = [phrases[0] ?? "", ...rest];
    return all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}` : all[0];
}
/** `$HOME` → `$HOME`, `${x:-y}` → `${…}`, `$(` → `$(…)`, `$?` → `$?`: the expansion at `i`, as a token to show. */
function dollarToken(command, i) {
    const next = command[i + 1] ?? "";
    if (next === "(")
        return { kind: "substitution", token: "$(…)" };
    if (next === "{")
        return { kind: "variable", token: "${…}" };
    const name = /^[A-Za-z_][A-Za-z0-9_]{0,23}/.exec(command.slice(i + 1))?.[0];
    if (name)
        return { kind: "variable", token: `$${name}` };
    return { kind: "variable", token: /[0-9?!#@*$-]/.test(next) ? `$${next}` : "$" };
}
/**
 * The operator that starts at `i`, whole: `&&` is one operator, not `&`
 * twice, and `2>` is a redirect, not a word and a `>`. Returns how many
 * characters it takes. `fd` is the digits written immediately before it,
 * when there were any (`2` in `2>`).
 */
function operatorAt(command, i, fd) {
    const ch = command[i];
    const next = command[i + 1] ?? "";
    switch (ch) {
        case "&":
            if (next === "&")
                return { finding: { kind: "chain", token: "&&" }, length: 2 };
            if (next === ">")
                return { finding: { kind: "redirect", token: command[i + 2] === ">" ? "&>>" : "&>" }, length: command[i + 2] === ">" ? 3 : 2 };
            return { finding: { kind: "background", token: "&" }, length: 1 };
        case "|":
            if (next === "|")
                return { finding: { kind: "chain", token: "||" }, length: 2 };
            if (next === "&")
                return { finding: { kind: "pipe", token: "|&" }, length: 2 };
            return { finding: { kind: "pipe", token: "|" }, length: 1 };
        case ";":
            return { finding: { kind: "chain", token: ";" }, length: 1 };
        case ">": {
            if (next === "(")
                return { finding: { kind: "substitution", token: ">(…)" }, length: 2 };
            const length = next === ">" || next === "&" || next === "|" ? 2 : 1;
            return { finding: { kind: "redirect", token: `${fd}${next === ">" ? ">>" : ">"}` }, length };
        }
        case "<": {
            if (next === "(")
                return { finding: { kind: "substitution", token: "<(…)" }, length: 2 };
            if (next === "<")
                return { finding: { kind: "input", token: command[i + 2] === "<" ? "<<<" : "<<" }, length: command[i + 2] === "<" ? 3 : 2 };
            return { finding: { kind: "input", token: `${fd}<` }, length: next === "&" || next === ">" ? 2 : 1 };
        }
        case "(":
        case ")":
            return { finding: { kind: "subshell", token: "(…)" }, length: 1 };
        case "`":
            return { finding: { kind: "substitution", token: "`…`" }, length: 1 };
        default: {
            const finding = dollarToken(command, i);
            // `$(` takes its parenthesis with it, so the `(` is not read again as a group.
            return { finding, length: finding.token === "$(…)" ? 2 : 1 };
        }
    }
}
/**
 * Characters a person cannot see, or cannot tell from a space, in a command
 * line: control bytes, every whitespace but space, tab and the line breaks
 * (which are their own finding), soft hyphen, the zero-width and bidi
 * controls, the blank Hangul fillers, and the tag block. A shell splits
 * words on space and tab only, so a line with a no-break space in it is not
 * the words it looks like; and an override can make it read as another
 * command altogether. Such a line always asks.
 */
exports.UNUSUAL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u00A0\u00AD\u061C\u115F\u1160\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;
/**
 * Read a command line once: its words, and every piece of shell structure
 * in it. Quotes are honoured — `git commit -m "fix; thing"` is one command
 * of four words — and anything the shell would read as structure or
 * substitution outside single quotes (`;`, `&`, `|`, `<`, `>`, parentheses,
 * a backtick, `$`, a newline, a leading NAME=value) is a finding. So is a
 * bare `{` or `}`: the shell expands `{-exec,rm}` into two words, which
 * would hide a flag from `indirectCommand` if braces were read as letters.
 * Words are split on space and tab alone, as the shell splits them; any
 * other blank or invisible character is a finding of its own. The scan
 * goes on past a finding, so a card can name every operator in the line
 * rather than the first; the words are only meaningful when there are none.
 */
function scanCommand(command, observer) {
    const findings = [];
    if (/[\r\n]/.test(command))
        findings.push({ kind: "lines", token: "" });
    if (exports.UNUSUAL_CHARS.test(command))
        findings.push({ kind: "unusual", token: "" });
    const argv = [];
    let word = "";
    let inWord = false;
    /** Whether the word so far was written bare — no quote, no escape — so its digits can be a file descriptor. */
    let bare = true;
    /** For the observer only: an unquoted `*`, `?` or `[` in the word, and an unquoted `~` at its start. */
    let glob = false;
    let tilde = false;
    let quote = null;
    /** Open `$(`/`<(`/`>(` and open plain `(`, so a closing `)` is counted with what it closes. */
    let substitutions = 0;
    let groups = 0;
    /** Open `${`, so the `}` that closes one is part of the variable already named. */
    let expansions = 0;
    const endWord = () => {
        if (inWord) {
            argv.push(word);
            observer?.word?.({ text: word, bare, glob, tilde });
        }
        word = "";
        inWord = false;
        bare = true;
        glob = false;
        tilde = false;
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            else
                word += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === '"') {
                quote = null;
                continue;
            }
            if (ch === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
                word += command[++i];
                continue;
            }
            if (ch === "$")
                findings.push(dollarToken(command, i));
            else if (ch === "`")
                findings.push({ kind: "substitution", token: "`…`" });
            word += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inWord = true;
            bare = false;
            continue;
        }
        if (ch === "\\") {
            if (i + 1 >= command.length) {
                findings.push({ kind: "backslash", token: "" });
                continue;
            }
            word += command[++i];
            inWord = true;
            bare = false;
            continue;
        }
        if (ch === " " || ch === "\t") {
            endWord();
            continue;
        }
        if (ch === "{" || ch === "}") {
            if (ch === "}" && expansions > 0)
                expansions -= 1;
            else
                findings.push({ kind: "brace", token: "{…}" });
            word += ch;
            inWord = true;
            continue;
        }
        if (CONTROL_CHARS.includes(ch)) {
            // The `)` that closes a `$(`, `<(` or `>(` belongs to the substitution already named.
            if (ch === ")" && substitutions > 0 && groups === 0) {
                substitutions -= 1;
                endWord();
                continue;
            }
            if (ch === "(")
                groups += 1;
            if (ch === ")" && groups > 0)
                groups -= 1;
            // `2>` and `0<`: digits written right against a redirect are its file descriptor, not a word.
            const fd = (ch === ">" || ch === "<") && inWord && bare && /^[0-9]+$/.test(word) ? word : "";
            if (fd) {
                word = "";
                inWord = false;
            }
            const operator = operatorAt(command, i, fd);
            const operatorRaw = command.slice(i, i + operator.length);
            findings.push(operator.finding);
            i += operator.length - 1;
            if (operator.finding.token.endsWith("(…)") && operator.finding.kind === "substitution")
                substitutions += 1;
            if (operator.finding.token === "${…}") {
                // `${` takes its brace with it, as `$(` takes its parenthesis.
                expansions += 1;
                i += 1;
            }
            // An operator ends the word before it; an expansion is part of the word it stands in.
            if (ch === "$" || ch === "`") {
                word += ch;
                inWord = true;
            }
            else
                endWord();
            // Told after the word it ended, so an observer sees the line in the order it is written.
            observer?.operator?.(operator.finding, operatorRaw);
            continue;
        }
        if (ch === "*" || ch === "?" || ch === "[")
            glob = true;
        if (ch === "~" && !inWord)
            tilde = true;
        word += ch;
        inWord = true;
    }
    if (quote)
        findings.push({ kind: "quote", token: "" });
    endWord();
    if (argv.length === 0)
        findings.push({ kind: "empty", token: "" });
    else {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]{0,23})[A-Za-z0-9_]*=/.exec(argv[0]);
        if (assignment)
            findings.push({ kind: "assignment", token: `${assignment[1]}=…` });
    }
    return { argv, findings };
}
/**
 * One simple command as argv, or why the line is not one — as the start of
 * a plain sentence naming the operators (`Chains commands with "&&"`). A
 * compound line still runs, but only after a card: never on a session
 * grant, never on an allowlist prefix, because `git status; rm -rf ~`
 * starts with `git status`.
 */
function parseSimpleCommand(command) {
    const { argv, findings } = scanCommand(command);
    return findings.length > 0 ? { ok: false, reason: describeStructure(findings) } : { ok: true, argv };
}
/** Matched as a substring of the normalised command line, case-insensitively — Nexora Desktop's list. */
exports.BLOCKED_COMMAND_PATTERNS = ["mkfs", "shutdown ", "reboot", "halt", "diskutil eraseDisk", "dd if=/dev/", ":(){:|:&};:"];
const RM_FLAGS = "(?:-[-a-z]*\\s+)*-[-a-z]*[rf][-a-z]*\\s+";
/** What may follow the target: whitespace, the end, or a shell character — `exec("rm -rf ~")` loses its quotes to normalisation and ends in `)`. */
const RM_END = "(?:[\\s;&|)]|$)";
const RM_ROOT = new RegExp(`\\brm\\s+${RM_FLAGS}/+(?:\\.?/?)\\*?${RM_END}`, "i");
const RM_HOME = new RegExp(`\\brm\\s+${RM_FLAGS}(?:~|\\$HOME)/?\\*?${RM_END}`, "i");
/**
 * The line as the denylist reads it: escapes and quotes removed, `$HOME`
 * spelled `~`, whitespace collapsed — so `r"m" -rf '/'` and `rm -rf "$HOME"`
 * read as what they are. A denylist that can be dodged with a quote mark is
 * not a denylist.
 */
function normaliseCommand(command) {
    return command
        .replace(/\\(.)/g, "$1")
        .replace(/["']/g, "")
        .replace(/\$\{?HOME\}?/g, "~")
        .replace(/\s+/g, " ")
        .trim();
}
/** The pattern a command (or a line of process input) trips, or null. */
function blockedCommand(command) {
    const plain = normaliseCommand(command);
    const lower = plain.toLowerCase();
    const hit = exports.BLOCKED_COMMAND_PATTERNS.find((entry) => lower.includes(entry.toLowerCase()));
    if (hit)
        return hit;
    if (RM_ROOT.test(plain))
        return "rm -rf /";
    if (RM_HOME.test(plain))
        return "rm -rf ~";
    return null;
}
/**
 * The grant key for a command: `shell:<program> <first word>` — `shell:git
 * push`, `shell:npm test` — or the program alone when the next word is a
 * flag (`shell:node` for `node -i`). The program is kept as written, so a
 * grant for `git` never covers `/tmp/x/git`. A compound line keys on its
 * first word for the audit, but never earns or uses a grant.
 */
function commandKey(command) {
    const parsed = parseSimpleCommand(command);
    if (parsed.ok) {
        const [program, next] = parsed.argv;
        return `shell:${program}${next && !next.startsWith("-") ? ` ${next}` : ""}`;
    }
    const first = command
        .trim()
        .split(/\s+/)
        .find((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    return `shell:${first ?? ""}`;
}
/* -------------------------------------------------- indirect commands */
/**
 * Programs that run whatever they are handed. A grant keyed on one of
 * them — `shell:sh`, `shell:node`, `shell:ssh host`, `shell:sudo apt` —
 * would be a grant on anything, and so would an allowlist entry; a command
 * whose program is one of these is asked about every time.
 */
/** Shells and language runtimes: programs whose argument is a program. */
const INTERPRETER_PROGRAMS = new Set([
    // shells
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "busybox", "cmd", "pwsh", "powershell",
    // language runtimes and their launchers
    "node", "nodejs", "deno", "bun", "npx", "perl", "ruby", "php", "rake", "uv", "pipx", "awk", "gawk", "mawk"
]);
exports.INDIRECT_PROGRAMS = new Set([
    ...INTERPRETER_PROGRAMS,
    // things that run a program for you, or as someone else, or somewhere else
    "ssh", "env", "xargs", "sudo", "doas", "su", "runuser", "chroot", "nohup", "setsid", "timeout", "nice", "ionice",
    "stdbuf", "flock", "script", "strace", "ltrace", "time", "watch", "osascript", "eval", "exec", "command",
    // editors with a command mode, build tools and container/cluster clients that take a command
    "vi", "vim", "ex", "make", "docker", "kubectl", "open", "start"
]);
/** `python`, `python3`, `python3.12`, `pypy3`, `ipython`. */
const INTERPRETER_RE = /^(?:python|pypy|ipython)[0-9.]*$/;
/** A flag whose value is code: `sh -c`, `perl -e`, `node --eval`, `pwsh -Command`, `cmd /c`. Checked on any program — `-c` is code more often than it is count. */
exports.CODE_FLAGS = new Set(["-c", "-e", "--eval", "--exec", "-command", "-Command", "--command", "/c", "/C", "/k", "/K"]);
/** `find … -exec rm {} \;` and `fd -x rm` run a command per match. */
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-x", "--exec", "-X", "--exec-batch"]);
/** `/usr/bin/env` → `env`; `Node.EXE` → `node`. */
function programName(word) {
    const base = word.slice(word.lastIndexOf("/") + 1).toLowerCase();
    return base.endsWith(".exe") ? base.slice(0, -4) : base;
}
/** The spelling of a code flag as a token to show: `--eval=1+1` → `--eval`. */
const flagName = (flag) => flag.split("=", 1)[0];
const isCodeFlag = (arg) => exports.CODE_FLAGS.has(arg) || /^--(?:eval|exec|command)=/.test(arg);
/**
 * Why a parsed command must be asked about every time, or undefined when a
 * grant on its key would mean what it says: the program is an interpreter
 * or runs other programs, the line carries code on a flag, or `find`/`fd`
 * is told to execute. The start of a plain sentence, naming the program or
 * the flag in quotes: `Runs an interpreter ("sh -c")`.
 */
function indirectCommand(argv) {
    const program = programName(argv[0] ?? "");
    const rest = argv.slice(1);
    if (INTERPRETER_PROGRAMS.has(program) || INTERPRETER_RE.test(program)) {
        const flag = rest.find(isCodeFlag);
        return `Runs an interpreter ("${program}${flag ? ` ${flagName(flag)}` : ""}")`;
    }
    if (exports.INDIRECT_PROGRAMS.has(program))
        return `Runs another command through "${program}"`;
    if (program === "find" || program === "fd") {
        const exec = rest.find((arg) => FIND_EXEC_FLAGS.has(arg));
        if (exec)
            return `Runs a command for each match ("${program} ${exec}")`;
    }
    const flag = rest.find(isCodeFlag);
    if (flag)
        return `Passes code on a flag ("${flagName(flag)}")`;
    return undefined;
}
/** What every reason ends with: what being compound or indirect means for the person answering the card. */
exports.ASKS_EVERY_TIME = "this asks every time.";
/**
 * Why a command line is asked about every time, as the card's own line — a
 * plain sentence naming the operators or the program in quotes, then what
 * it means: `Chains commands with "&&" — this asks every time.` Undefined
 * when a session grant may cover the command.
 */
function onceReason(command) {
    const parsed = parseSimpleCommand(command);
    const why = parsed.ok ? indirectCommand(parsed.argv) : parsed.reason;
    return why === undefined ? undefined : `${why} — ${exports.ASKS_EVERY_TIME}`;
}
/**
 * Values that travel on a command line as secrets, blanked before a line is
 * written anywhere: `--token=…`, `--password …`, `Authorization: Bearer …`,
 * `user:pass@` in a URL, `TOKEN=…` assignments.
 */
function scrubCommandSecrets(text) {
    return text
        .replace(/(authorization:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, "$1[redacted]")
        // The lookbehind keeps `--with-token` (a flag that takes no value) from being read as `-token`.
        .replace(/((?<![\w-])--?(?:token|password|passwd|pass|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth|credentials?)[=\s]+)[^\s"']+/gi, "$1[redacted]")
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@")
        .replace(/(\b(?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_?KEY|ACCESS_KEY)[A-Z0-9_]*)=)[^\s"']+/g, "$1[redacted]");
}
/**
 * What a program printed, as the model may see it: command-line secrets and
 * key material blanked, the way a file read is. A private key in the output
 * withholds the whole of it, as it does a file.
 */
function scrubOutput(text) {
    const scrubbed = (0, archive_1.scrubKeyMaterial)(scrubCommandSecrets(text));
    return scrubbed.startsWith("[skipped:") ? "[output withheld: it contains a private key]" : scrubbed;
}
