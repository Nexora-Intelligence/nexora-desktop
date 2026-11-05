"use strict";
/**
 * A zip archive (or a folder zipped by a client), rendered for the model.
 *
 * What the model needs from a project is its shape and its source: a tree,
 * then the text files, with the dependency and build folders left out the way
 * a code review leaves them out. Binary files are named but not inlined, lock
 * files and `.env` files are named and skipped (one is noise, the other is
 * someone's secrets), and Office documents found inside are rendered with the
 * same readers an attachment of their own would get. Everything is bounded:
 * entries listed, characters per file, characters in total — and the render
 * says what it cut, so the person can ask for a path by name.
 *
 * Pure module — see SYNC.md; it has copies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IGNORED_DIRS = void 0;
exports.isSecretPath = isSecretPath;
exports.scrubKeyMaterial = scrubKeyMaterial;
exports.isIgnoredPath = isIgnoredPath;
exports.skipReasonFor = skipReasonFor;
exports.looksTextual = looksTextual;
exports.renderArchive = renderArchive;
const office_1 = require("./office");
const zip_1 = require("./zip");
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_MAX_FILE_CHARS = 40_000;
const DEFAULT_MAX_ENTRIES = 400;
/** Bytes sniffed for NUL when the extension does not settle the question. */
const SNIFF_BYTES = 8 * 1024;
/** An entry larger than this is listed, never inflated: no 40k-character render needs 100 MB in memory. */
const MAX_INLINE_ENTRY_BYTES = 8 * 1024 * 1024;
/** Bytes one render may inflate in total, declared sizes summed, when the caller set no cap. */
const ARCHIVE_BUDGET_BYTES = 64 * 1024 * 1024;
/** What an Office package found inside an archive may itself declare. */
const NESTED_PACKAGE_BYTES = 32 * 1024 * 1024;
const NESTED_PACKAGE_ENTRIES = 4_000;
/** Folders that hold what a build produces or fetches, never what a person wrote. */
exports.IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "coverage",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "vendor",
    "Pods",
    ".gradle",
    ".idea",
    ".vscode",
    ".DS_Store",
    "__MACOSX"
]);
const LOCK_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "composer.lock",
    "Gemfile.lock",
    "go.sum"
]);
const TEXT_EXTENSIONS = new Set([
    "txt", "md", "markdown", "rst", "adoc", "csv", "tsv", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "xml", "html", "htm", "css", "scss", "sass", "less", "svg",
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro",
    "py", "pyi", "rb", "php", "go", "rs", "java", "kt", "kts", "scala", "groovy", "swift", "m", "mm", "c", "h", "cc", "cpp", "hpp", "cs", "fs",
    "dart", "lua", "r", "jl", "ex", "exs", "erl", "hs", "ml", "clj", "cljs", "edn", "lisp", "el", "scm",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "proto", "thrift",
    "tf", "hcl", "dockerfile", "makefile", "cmake", "gradle", "properties", "lock", "log", "ipynb", "tex", "bib", "diff", "patch", "gitignore", "editorconfig", "prettierrc", "eslintrc"
]);
/** Folders that exist to hold credentials. */
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".gpg", ".azure", ".kube", "secrets", ".secrets"]);
/** Files that are credentials by convention, whatever is in them. */
const SECRET_NAMES = new Set([
    ".env",
    ".envrc",
    ".npmrc",
    ".yarnrc",
    ".netrc",
    ".pgpass",
    ".htpasswd",
    ".git-credentials",
    "credentials",
    "credentials.json",
    "token.json",
    "kubeconfig"
]);
const SECRET_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "ppk", "asc", "gpg", "kdbx", "crt-key"]);
/**
 * True of a path that holds someone's credentials: dotenv files under any
 * name (`.env`, `.env.production`, `prod.env`), SSH and cloud credential
 * folders, private keys and keystores, and anything calling itself
 * credentials. Public keys and ordinary words like "environment" pass.
 */
function isSecretPath(path) {
    const segments = path.split("/").filter(Boolean);
    const name = (segments[segments.length - 1] ?? "").toLowerCase();
    // A credentials folder is secret as a whole — as a parent and as itself.
    if (segments.some((d) => SECRET_DIRS.has(d.toLowerCase())))
        return true;
    if (SECRET_NAMES.has(name))
        return true;
    if (/^\.env(\.|$)/.test(name) || name.endsWith(".env"))
        return true;
    if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name))
        return true;
    if (/credential/.test(name) && /\.(json|ya?ml|txt|ini|cfg|xml)$/.test(name))
        return true;
    if (/^secrets?\./.test(name))
        return true;
    return SECRET_EXTENSIONS.has(extensionOf(path));
}
/**
 * The armor line of any private key, tolerant of odd spacing and tabs between
 * the words. Every quantifier is bounded and the line is tested on its own
 * (see `hasPrivateKey`), so the cost is linear in the text.
 */
const PRIVATE_KEY_RE = /-{3,}[^\S\n]{0,8}BEGIN[^\S\n][^\n]{0,40}PRIVATE[^\S\n]{1,8}KEY([^\S\n]{1,8}BLOCK)?[^\S\n]{0,8}-{3,}/i;
/** The armor line can be at most this long; a window of this size around each BEGIN sees all of it. */
const ARMOR_WINDOW = 120;
/**
 * True when the body carries a private-key armor line — on its own line, at
 * the end of a long one, or inside a JSON string with `\n` spelled out, as
 * a service-account file has it. Every BEGIN is tested in a bounded window,
 * so the cost is linear whatever the shape of the text.
 */
function hasPrivateKey(body) {
    if (!/BEGIN/i.test(body))
        return false;
    // Escaped newlines become real ones so an embedded PEM reads as lines.
    const text = body.replace(/\\r\\n|\\n|\r\n?/g, "\n");
    const probe = /BEGIN/gi;
    let m;
    while ((m = probe.exec(text)) !== null) {
        const window = text.slice(Math.max(0, m.index - 8), m.index + ARMOR_WINDOW);
        if (PRIVATE_KEY_RE.test(window))
            return true;
    }
    return false;
}
const ACCESS_KEY_ID_RE = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
/** Tokens with a recognisable prefix or label: redacted in place, the line kept. */
const TOKEN_RES = [
    /\bghp_[A-Za-z0-9]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g
];
/** `aws_secret_access_key = …`, `client_secret: "…"` — the label stays, the value goes. */
const LABELLED_SECRET_RE = /\b(aws_secret_access_key|secret_access_key|client_secret|private_key|api[_-]?key|access[_-]?token|refresh[_-]?token)\b([^\S\n]{0,40}[:=][^\S\n]{0,40})(["']?)[^\s"',;]{8,}\3/gi;
/** Text that must not reach a prompt even from a file that looked ordinary. */
function scrubKeyMaterial(body) {
    if (hasPrivateKey(body))
        return "[skipped: this file contains a private key]";
    let out = body.replace(ACCESS_KEY_ID_RE, "[redacted access key id]");
    for (const re of TOKEN_RES)
        out = out.replace(re, "[redacted secret]");
    return out.replace(LABELLED_SECRET_RE, (_match, label, sep) => `${label}${sep}[redacted secret]`);
}
const BINARY_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "psd", "ai",
    "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mov", "avi", "mkv", "webm",
    "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "tar",
    "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "pyc", "wasm", "node",
    "ttf", "otf", "woff", "woff2", "eot", "sqlite", "db", "parquet", "feather", "npy", "npz", "pkl", "h5", "onnx", "pt", "pth", "safetensors"
]);
const OFFICE_EXTENSIONS = new Set(["docx", "docm", "xlsx", "xlsm", "pptx", "pptm"]);
function extensionOf(path) {
    const base = basename(path).toLowerCase();
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot + 1) : base;
}
function basename(path) {
    return path.slice(path.lastIndexOf("/") + 1);
}
/** True when any folder on the path is one nobody wants to read. */
function isIgnoredPath(path) {
    const segments = path.split("/");
    const dirs = segments.slice(0, -1);
    if (dirs.some((d) => exports.IGNORED_DIRS.has(d)))
        return true;
    const name = segments[segments.length - 1] ?? "";
    return name === ".DS_Store" || name === "Thumbs.db";
}
/** Why a path would be left out, or undefined when it should be read. */
function skipReasonFor(path, head) {
    if (isIgnoredPath(path))
        return "ignored folder";
    if (isSecretPath(path))
        return "secrets";
    const name = basename(path);
    const ext = extensionOf(path);
    if (LOCK_FILES.has(name))
        return "lock file";
    if (ext === "zip" || ext === "tar" || ext === "gz" || ext === "tgz" || ext === "7z" || ext === "rar")
        return "archive";
    if (OFFICE_EXTENSIONS.has(ext))
        return undefined;
    if (BINARY_EXTENSIONS.has(ext))
        return "binary";
    if (name.endsWith(".min.js") || name.endsWith(".min.css") || name.endsWith(".map"))
        return "binary";
    if (TEXT_EXTENSIONS.has(ext) || name.toLowerCase() === "dockerfile" || name.toLowerCase() === "makefile" || name.toLowerCase() === "license")
        return undefined;
    if (head)
        return looksTextual(head) ? undefined : "binary";
    return undefined;
}
/** A NUL in the first few kilobytes is the one reliable sign of a binary file. */
function looksTextual(head) {
    const n = Math.min(head.length, SNIFF_BYTES);
    let control = 0;
    for (let i = 0; i < n; i++) {
        const b = head[i];
        if (b === 0)
            return false;
        if (b < 7 || (b > 13 && b < 32))
            control++;
    }
    return n === 0 || control / n < 0.1;
}
const utf8 = new TextDecoder("utf-8");
function renderArchive(name, bytes, opts) {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    const maxFileChars = opts.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    // One inflater for the archive and every Office package inside it, counting
    // the bytes it actually produced against one budget. The declared-size
    // check in `readZip` still refuses an archive that is too big on paper;
    // this is what stops a nested package from spending the budget again.
    const budgetBytes = opts.maxTotalBytes ?? ARCHIVE_BUDGET_BYTES;
    let inflated = 0;
    const counting = (data, maxOutputLength) => {
        const out = opts.inflateRaw(data, maxOutputLength);
        inflated += out.length;
        if (inflated > budgetBytes)
            throw new zip_1.ZipError(`archive inflates past ${(0, zip_1.formatBytes)(budgetBytes)}`, "too-large");
        return out;
    };
    const readOpts = { inflateRaw: counting, ...(opts.maxTotalBytes !== undefined ? { maxTotalBytes: opts.maxTotalBytes } : {}) };
    const entries = (0, zip_1.readZip)(bytes, readOpts)
        .filter((e) => !e.isDirectory)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const locked = entries.find((e) => e.encrypted);
    if (locked) {
        // Surface it through the reader's own error so the caller words it once.
        locked.data();
    }
    const unpacked = entries.reduce((n, e) => n + e.size, 0);
    const skippedFolders = new Map();
    const listed = [];
    const toRead = [];
    let skipped = 0;
    for (const entry of entries) {
        const reason = skipReasonFor(entry.path);
        if (reason === "ignored folder") {
            skipped++;
            const folder = entry.path.split("/").find((seg) => exports.IGNORED_DIRS.has(seg)) ?? "(ignored)";
            skippedFolders.set(folder, (skippedFolders.get(folder) ?? 0) + 1);
            continue;
        }
        if (reason) {
            skipped++;
            if (listed.length < maxEntries)
                listed.push(`${entry.path} (${(0, zip_1.formatBytes)(entry.size)}, ${reason} — not shown)`);
            continue;
        }
        if (entry.size > MAX_INLINE_ENTRY_BYTES) {
            skipped++;
            if (listed.length < maxEntries)
                listed.push(`${entry.path} (${(0, zip_1.formatBytes)(entry.size)}, too large to show)`);
            continue;
        }
        if (listed.length < maxEntries)
            listed.push(`${entry.path} (${(0, zip_1.formatBytes)(entry.size)})`);
        toRead.push({ entry, office: OFFICE_EXTENSIONS.has(extensionOf(entry.path)) });
    }
    const visible = entries.length - [...skippedFolders.values()].reduce((a, b) => a + b, 0);
    const more = visible - listed.length;
    const header = [];
    const folders = [...skippedFolders.entries()].map(([f, n]) => `${f} (${n})`).join(", ");
    header.push(`Archive **${name}** — ${toRead.length} readable file${toRead.length === 1 ? "" : "s"} of ${entries.length} (${(0, zip_1.formatBytes)(unpacked)} unpacked)` +
        (folders ? `; skipped under ${folders}` : ""));
    header.push("", "Tree:", ...listed);
    if (more > 0)
        header.push(`[… ${more} more entries not listed]`);
    header.push("");
    let text = header.join("\n");
    let truncated = more > 0;
    let included = 0;
    let cutFiles = 0;
    for (let i = 0; i < toRead.length; i++) {
        const { entry, office } = toRead[i];
        const remaining = maxChars - text.length;
        if (remaining < 400) {
            cutFiles = toRead.length - i;
            break;
        }
        let body;
        let label = entry.path;
        try {
            if (inflated + entry.size > budgetBytes) {
                throw new zip_1.ZipError(`archive inflates past ${(0, zip_1.formatBytes)(budgetBytes)}`, "too-large");
            }
            const data = entry.data();
            if (entry.method === 0)
                inflated += data.length; // stored bytes bypass the inflater
            if (office) {
                const ext = extensionOf(entry.path);
                const kind = ext.startsWith("doc") ? "Word" : ext.startsWith("xls") ? "Excel" : "PowerPoint";
                label = `${entry.path} (${kind})`;
                const nested = {
                    inflateRaw: counting,
                    maxEntries: NESTED_PACKAGE_ENTRIES,
                    maxTotalBytes: Math.max(1, Math.min(NESTED_PACKAGE_BYTES, budgetBytes - inflated))
                };
                body = scrubKeyMaterial(ext.startsWith("doc") ? (0, office_1.extractDocx)(data, nested) : ext.startsWith("xls") ? (0, office_1.extractXlsx)(data, nested) : (0, office_1.extractPptx)(data, nested));
            }
            else {
                if (!looksTextual(data.subarray(0, SNIFF_BYTES))) {
                    body = "[binary content — not shown]";
                }
                else {
                    body = scrubKeyMaterial(utf8.decode(data).replace(/\r\n?/g, "\n"));
                }
            }
        }
        catch (error) {
            // A member that lies about its size or is encrypted condemns the whole
            // archive; one that is merely damaged is reported in place and the
            // rest of the archive still renders.
            if (error instanceof zip_1.ZipError && (error.code === "too-large" || error.code === "encrypted"))
                throw error;
            body = `[could not read: ${error instanceof Error ? error.message : String(error)}]`;
        }
        const budget = Math.min(maxFileChars, remaining - 200);
        if (body.length > budget) {
            body = `${body.slice(0, budget)}\n[truncated: showing ${budget.toLocaleString()} of ${body.length.toLocaleString()} characters]`;
            truncated = true;
        }
        text += `\n--- ${label} ---\n${body}\n`;
        included++;
    }
    if (cutFiles > 0) {
        text += `\n[truncated: ${cutFiles} more file${cutFiles === 1 ? "" : "s"} not shown — ask for a path by name]\n`;
        truncated = true;
    }
    return { text: text.trimEnd(), truncated, included, skipped };
}
