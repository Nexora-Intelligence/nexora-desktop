"use strict";
/**
 * The text of Word, Excel and PowerPoint files, read from their XML parts.
 *
 * Office Open XML is a zip of XML parts, and the prose in each is easy to
 * recover without an XML parser: `<w:t>` holds Word's runs, `<a:t>` holds
 * PowerPoint's, and a worksheet is rows of `<c>` cells whose strings mostly
 * live in a shared table. Styles, revisions, themes and layout are markup a
 * reader of the *content* does not need, so they are skipped rather than
 * rendered. Pure module — see SYNC.md; it has copies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfficeError = void 0;
exports.decodeEntities = decodeEntities;
exports.extractDocx = extractDocx;
exports.extractXlsx = extractXlsx;
exports.extractPptx = extractPptx;
const zip_1 = require("./zip");
/** The package is a zip but not the Office document its name claims. */
class OfficeError extends Error {
}
exports.OfficeError = OfficeError;
const utf8 = new TextDecoder("utf-8");
function openPackage(bytes, opts) {
    const entries = new Map();
    for (const entry of (0, zip_1.readZip)(bytes, opts)) {
        if (!entry.isDirectory)
            entries.set(entry.path, entry);
    }
    const cache = new Map();
    return {
        has: (path) => entries.has(path),
        part: (path) => {
            const hit = cache.get(path);
            if (hit !== undefined)
                return hit;
            const entry = entries.get(path);
            if (!entry)
                return undefined;
            const text = utf8.decode(entry.data());
            cache.set(path, text);
            return text;
        }
    };
}
function decodeEntities(s) {
    if (!s.includes("&"))
        return s;
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}
/** One attribute of a start tag's attribute string. */
function attr(attrs, name) {
    const m = new RegExp(`(?:^|\\s)${name.replace(/:/g, "\\:")}="([^"]*)"`).exec(attrs);
    return m ? decodeEntities(m[1]) : undefined;
}
/** `Id → Target` of a relationships part, targets resolved against `baseDir`. */
function relationships(pkg, relsPath, baseDir) {
    const out = new Map();
    const xml = pkg.part(relsPath);
    if (!xml)
        return out;
    for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
        const id = attr(m[1], "Id");
        const target = attr(m[1], "Target");
        const type = attr(m[1], "Type") ?? "";
        if (id && target)
            out.set(id, { target: resolvePath(baseDir, target), type });
    }
    return out;
}
function resolvePath(baseDir, target) {
    if (target.startsWith("/"))
        return target.slice(1);
    const parts = baseDir.split("/").filter(Boolean);
    for (const seg of target.split("/")) {
        if (seg === "..")
            parts.pop();
        else if (seg && seg !== ".")
            parts.push(seg);
    }
    return parts.join("/");
}
function collapseBlankLines(lines) {
    return lines
        .join("\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
// ---------------------------------------------------------------------------
// Word
const HEADING_PREFIX = {
    title: "# ",
    heading1: "# ",
    heading2: "## ",
    heading3: "### ",
    heading4: "#### "
};
/**
 * Paragraphs in document order, headings marked, tables as ` | `-joined rows.
 * A tag-level walk rather than a strip-all-tags pass, because a table's cells
 * each hold paragraphs of their own and would otherwise come out one per line.
 */
function extractDocx(bytes, opts) {
    const pkg = openPackage(bytes, opts);
    const raw = pkg.part("word/document.xml");
    if (!raw)
        throw new OfficeError("no word/document.xml");
    // Word writes drawings twice — the modern markup in `mc:Choice` and a
    // legacy copy in `mc:Fallback` for old readers. Reading both would repeat
    // every text box, so the fallback is dropped before the walk.
    const xml = raw.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
    const lines = [];
    let paragraph = "";
    let style;
    let tableDepth = 0;
    let cellParagraphs = [];
    let rowCells = [];
    const endParagraph = () => {
        if (tableDepth > 0)
            cellParagraphs.push(paragraph);
        else
            lines.push((style && HEADING_PREFIX[style.toLowerCase()]) ? `${HEADING_PREFIX[style.toLowerCase()]}${paragraph}` : paragraph);
        paragraph = "";
        style = undefined;
    };
    const TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<(\/?)(w:p|w:tbl|w:tr|w:tc|w:tab|w:br|w:cr|w:pStyle|w:delText)\b([^>]*?)(\/?)>/g;
    for (const m of xml.matchAll(TOKEN)) {
        if (m[1] !== undefined) {
            paragraph += decodeEntities(m[1]);
            continue;
        }
        if (m[3] === undefined)
            continue; // self-closing empty <w:t/>
        const closing = m[2] === "/";
        const tag = m[3];
        const selfClosing = m[5] === "/";
        switch (tag) {
            case "w:p":
                if (closing || selfClosing)
                    endParagraph();
                else {
                    paragraph = "";
                    style = undefined;
                }
                break;
            case "w:pStyle":
                style = attr(m[4], "w:val");
                break;
            case "w:tab":
                paragraph += "\t";
                break;
            case "w:br":
            case "w:cr":
                paragraph += "\n";
                break;
            case "w:tbl":
                if (closing) {
                    tableDepth--;
                    lines.push("");
                }
                else
                    tableDepth++;
                break;
            case "w:tr":
                if (closing)
                    lines.push(rowCells.join(" | "));
                else
                    rowCells = [];
                break;
            case "w:tc":
                if (closing)
                    rowCells.push(cellParagraphs.join(" ").trim());
                else
                    cellParagraphs = [];
                break;
            default:
                break;
        }
    }
    return collapseBlankLines(lines);
}
// ---------------------------------------------------------------------------
// Excel
/** Column letters of a cell reference (`BC12` → 54, zero-based). */
function columnIndex(ref) {
    let n = 0;
    for (const ch of ref) {
        if (ch < "A" || ch > "Z")
            break;
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}
const MAX_COLUMNS = 256;
/**
 * Every sheet, in workbook order, as `## Sheet` followed by tab-separated
 * rows. Cells show their cached value; a formula without one shows as `=…`,
 * which is what the author sees in the formula bar before recalculation.
 */
function extractXlsx(bytes, opts) {
    const pkg = openPackage(bytes, opts);
    const workbook = pkg.part("xl/workbook.xml");
    if (!workbook)
        throw new OfficeError("no xl/workbook.xml");
    const rels = relationships(pkg, "xl/_rels/workbook.xml.rels", "xl");
    const shared = [];
    const sst = pkg.part("xl/sharedStrings.xml");
    if (sst) {
        for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
            const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
            shared.push(Array.from(body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g), (t) => decodeEntities(t[1])).join(""));
        }
    }
    const out = [];
    for (const sheet of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
        const name = attr(sheet[1], "name") ?? "Sheet";
        const rid = attr(sheet[1], "r:id");
        const hidden = attr(sheet[1], "state") === "hidden";
        const target = rid ? rels.get(rid)?.target : undefined;
        const xml = target ? pkg.part(target) : undefined;
        out.push(`## ${name}${hidden ? " (hidden)" : ""}`);
        if (!xml) {
            out.push("(sheet data not found)", "");
            continue;
        }
        for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells = [];
            for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const attrs = c[1];
                const inner = c[2] ?? "";
                const ref = attr(attrs, "r") ?? "";
                const col = ref ? columnIndex(ref) : cells.length;
                if (col < 0 || col >= MAX_COLUMNS)
                    continue;
                const value = cellValue(attr(attrs, "t"), inner, shared);
                while (cells.length < col)
                    cells.push("");
                cells[col] = value;
            }
            while (cells.length && cells[cells.length - 1] === "")
                cells.pop();
            if (cells.length)
                out.push(cells.join("\t"));
        }
        out.push("");
    }
    return collapseBlankLines(out);
}
function cellValue(type, inner, shared) {
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
    const f = /<f\b[^>]*>([^<]*)<\/f>/.exec(inner)?.[1];
    switch (type) {
        case "s":
            return v !== undefined ? (shared[Number(v)] ?? "") : "";
        case "inlineStr":
            return Array.from(inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g), (t) => decodeEntities(t[1])).join("");
        case "b":
            return v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        default:
            if (v !== undefined && v !== "")
                return decodeEntities(v);
            if (f !== undefined)
                return `=${decodeEntities(f)}`;
            return "";
    }
}
// ---------------------------------------------------------------------------
// PowerPoint
/**
 * Slides in presentation order: `## Slide N: Title`, then the text of each
 * shape and table, then the speaker notes. Shapes come out in the order the
 * XML lists them, which is the order PowerPoint added them — titles first on
 * every built-in layout.
 */
function extractPptx(bytes, opts) {
    const pkg = openPackage(bytes, opts);
    const presentation = pkg.part("ppt/presentation.xml");
    if (!presentation)
        throw new OfficeError("no ppt/presentation.xml");
    const rels = relationships(pkg, "ppt/_rels/presentation.xml.rels", "ppt");
    const out = [];
    let number = 0;
    for (const sld of presentation.matchAll(/<p:sldId\b([^>]*?)\/?>/g)) {
        const rid = attr(sld[1], "r:id");
        const target = rid ? rels.get(rid)?.target : undefined;
        const xml = target ? pkg.part(target) : undefined;
        number++;
        if (!xml) {
            out.push(`## Slide ${number}: (missing)`, "");
            continue;
        }
        const { title, lines } = slideText(xml);
        out.push(`## Slide ${number}: ${title || "(untitled)"}`, ...lines);
        if (target) {
            const dir = target.slice(0, target.lastIndexOf("/"));
            const file = target.slice(target.lastIndexOf("/") + 1);
            const slideRels = relationships(pkg, `${dir}/_rels/${file}.rels`, dir);
            for (const rel of slideRels.values()) {
                if (!rel.type.endsWith("/notesSlide"))
                    continue;
                const notes = pkg.part(rel.target);
                if (!notes)
                    continue;
                const text = slideText(notes, { skipPlaceholders: ["sldNum", "sldImg"] }).lines.join("\n").trim();
                if (text)
                    out.push(`Notes: ${text}`);
            }
        }
        out.push("");
    }
    return collapseBlankLines(out);
}
function slideText(xml, opts = {}) {
    const skip = new Set(opts.skipPlaceholders ?? []);
    let title = "";
    const lines = [];
    const SHAPE = /<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g;
    for (const shape of xml.matchAll(SHAPE)) {
        const block = shape[0];
        const ph = /<p:ph\b([^>]*?)\/?>/.exec(block);
        const phType = ph ? (attr(ph[1], "type") ?? "body") : undefined;
        if (phType && skip.has(phType))
            continue;
        if (block.includes("<a:tbl>")) {
            for (const row of block.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
                const cells = Array.from(row[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g), (tc) => paragraphsOf(tc[1]).join(" ").trim());
                lines.push(cells.join(" | "));
            }
            continue;
        }
        const paragraphs = paragraphsOf(block);
        if (!title && (phType === "title" || phType === "ctrTitle")) {
            title = paragraphs.join(" ").trim();
            continue;
        }
        lines.push(...paragraphs);
    }
    return { title, lines };
}
/** The text of each `<a:p>` in a block, indented by its outline level. */
function paragraphsOf(block) {
    const out = [];
    for (const p of block.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
        const body = p[1];
        const level = Number(/<a:pPr\b[^>]*\blvl="(\d)"/.exec(body)?.[1] ?? "0");
        const text = body
            .replace(/<a:br\b[^>]*\/?>/g, "\n")
            .replace(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g, (_, t) => decodeEntities(t))
            .replace(/<[^>]+>/g, "")
            .trim();
        if (text)
            out.push(`${"  ".repeat(level)}${text}`);
    }
    return out;
}
