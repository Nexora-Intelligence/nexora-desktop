"use strict";
/**
 * Document attachments: Word, Excel, PowerPoint and zip archives (which is
 * also how a folder arrives), turned into text the model can read.
 *
 * This is the Node entry point — it binds the pure readers in `zip.ts`,
 * `office.ts` and `archive.ts` to `node:zlib` and words every refusal for the
 * person who attached the file. The chat runtime calls it from
 * `buildUserContent`; the Nexora Code host calls it before a direct-provider
 * turn. See SYNC.md in this folder for the copies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatBytes = exports.DocumentRejected = void 0;
exports.documentKindFor = documentKindFor;
exports.isDocumentAttachment = isDocumentAttachment;
exports.extractDocument = extractDocument;
const node_zlib_1 = require("node:zlib");
const archive_1 = require("./archive");
const office_1 = require("./office");
const zip_1 = require("./zip");
Object.defineProperty(exports, "formatBytes", { enumerable: true, get: function () { return zip_1.formatBytes; } });
/** An attachment the model cannot take. The message is written for the user. */
class DocumentRejected extends Error {
    constructor(message) {
        super(message);
        this.name = "DocumentRejected";
    }
}
exports.DocumentRejected = DocumentRejected;
const DEFAULT_MAX_CHARS = 200_000;
const BY_EXTENSION = {
    docx: "docx",
    docm: "docx",
    xlsx: "xlsx",
    xlsm: "xlsx",
    pptx: "pptx",
    pptm: "pptx",
    zip: "zip",
    doc: "legacy-office",
    xls: "legacy-office",
    ppt: "legacy-office"
};
const BY_MEDIA_TYPE = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-word.document.macroenabled.12": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptx",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/x-zip": "zip",
    "multipart/x-zip": "zip",
    "application/msword": "legacy-office",
    "application/vnd.ms-excel": "legacy-office",
    "application/vnd.ms-powerpoint": "legacy-office"
};
const LABEL = {
    docx: "Word document",
    xlsx: "Excel workbook",
    pptx: "PowerPoint deck",
    zip: "zip archive"
};
/**
 * Which reader a name and media type call for. The extension decides when it
 * is known — browsers send `application/octet-stream` or nothing for Office
 * files more often than not — and the media type decides when there is no
 * extension to go on. `undefined` means "not ours": images, PDFs and plain
 * text keep their existing paths.
 */
function documentKindFor(name, mediaType) {
    const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
    const dot = base.lastIndexOf(".");
    const ext = dot >= 0 ? base.slice(dot + 1) : "";
    if (ext && BY_EXTENSION[ext])
        return BY_EXTENSION[ext];
    const mime = (mediaType ?? "").toLowerCase().split(";")[0].trim();
    if (mime && BY_MEDIA_TYPE[mime])
        return BY_MEDIA_TYPE[mime];
    return undefined;
}
/** True when `extractDocument` is the right path for this attachment. */
function isDocumentAttachment(name, mediaType) {
    return documentKindFor(name, mediaType) !== undefined;
}
/** Raw inflate that refuses to produce more than the declared size (see ReadZipOptions). */
function inflateRaw(data, maxOutputLength) {
    return new Uint8Array((0, node_zlib_1.inflateRawSync)(data, { maxOutputLength: Math.max(1, maxOutputLength) }));
}
function extractDocument(name, mediaType, bytes, opts = {}) {
    const kind = documentKindFor(name, mediaType);
    if (kind === "legacy-office") {
        throw new DocumentRejected(`"${name}" is an older binary Office file (.doc/.xls/.ppt) the model can't read. ` +
            `Open it in Word, Excel or PowerPoint, save it as .docx/.xlsx/.pptx, and attach that copy instead.`);
    }
    if (!kind) {
        throw new DocumentRejected(`"${name}" isn't a document type this reader handles.`);
    }
    const label = LABEL[kind];
    if (!(0, zip_1.isZip)(bytes)) {
        throw new DocumentRejected(`"${name}" isn't a readable ${label} — the file may be corrupt or mislabeled. Re-save it and attach it again.`);
    }
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    // One set of caps for every reader: an Office package is a zip too, and a
    // bomb dressed as a .docx must meet the same ceiling as one called .zip.
    const readOpts = {
        inflateRaw,
        ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
        ...(opts.maxTotalBytes !== undefined ? { maxTotalBytes: opts.maxTotalBytes } : {})
    };
    try {
        if (kind === "zip") {
            const render = (0, archive_1.renderArchive)(name, bytes, { ...readOpts, maxChars });
            return { kind, title: name, text: render.text, truncated: render.truncated };
        }
        // A key pasted into a document is still a key.
        const text = (0, archive_1.scrubKeyMaterial)(kind === "docx" ? (0, office_1.extractDocx)(bytes, readOpts) : kind === "xlsx" ? (0, office_1.extractXlsx)(bytes, readOpts) : (0, office_1.extractPptx)(bytes, readOpts));
        if (text.length > maxChars) {
            return {
                kind,
                title: name,
                text: `${text.slice(0, maxChars)}\n[truncated: showing ${maxChars.toLocaleString()} of ${text.length.toLocaleString()} characters]`,
                truncated: true
            };
        }
        return { kind, title: name, text, truncated: false };
    }
    catch (error) {
        throw refusal(name, label, error);
    }
}
function refusal(name, label, error) {
    if (error instanceof DocumentRejected)
        return error;
    if (error instanceof zip_1.ZipError) {
        switch (error.code) {
            case "encrypted":
                return new DocumentRejected(`"${name}" is password-protected, and the model can't read encrypted files. ` +
                    `Unzip it with its password, re-zip it without one, and attach that copy instead.`);
            case "too-large":
                return new DocumentRejected(`"${name}" is too large to attach once unpacked (${error.message}). ` +
                    `Zip only the folders you need — build output and dependencies are skipped anyway.`);
            case "unsupported":
                return new DocumentRejected(`"${name}" uses a zip feature this reader doesn't support (${error.message}). ` +
                    `Re-zip it with standard deflate compression and attach that copy instead.`);
            default:
                return new DocumentRejected(`"${name}" couldn't be unpacked (${error.message}) — the file may be truncated or corrupt. Re-create it and attach it again.`);
        }
    }
    if (error instanceof office_1.OfficeError) {
        return new DocumentRejected(`"${name}" is a zip but not a ${label} (${error.message}). Check the file and attach it again.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new DocumentRejected(`"${name}" couldn't be read (${detail}).`);
}
