"use strict";
/**
 * The ZIP container, read and written without a dependency or a platform.
 *
 * Office documents are zips of XML, folders arrive as zips the browser or the
 * editor built, and archives are what people attach when they want to show a
 * whole project. All of that runs through here. The module is pure: it takes
 * `Uint8Array`s and the inflate/deflate functions it should use, so the same
 * file compiles in the runtime (node:zlib), in the Nexora Code host (node:zlib)
 * and in the web chat (CompressionStream, or no compression at all). See
 * SYNC.md in this folder — this file has copies, and a change here is a change
 * to every copy.
 *
 * Deliberately not a general archive library: stored and deflate only, no
 * ZIP64, no encryption, no streaming. An archive that needs any of those is one
 * we decline, by name, rather than half-read.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZipError = void 0;
exports.isZip = isZip;
exports.readZip = readZip;
exports.createZip = createZip;
exports.crc32 = crc32;
exports.formatBytes = formatBytes;
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;
/** EOCD is 22 bytes plus a comment of at most 65 535. */
const EOCD_WINDOW = 22 + 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Why an archive could not be read. `code` lets a caller word the refusal. */
class ZipError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "ZipError";
    }
}
exports.ZipError = ZipError;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** True when the bytes begin with a local header or end with a central directory. */
function isZip(bytes) {
    if (bytes.length < 22)
        return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === LOCAL_FILE_HEADER)
        return true;
    return findEndRecord(view) >= 0;
}
function findEndRecord(view) {
    const from = Math.max(0, view.byteLength - EOCD_WINDOW);
    for (let at = view.byteLength - 22; at >= from; at--) {
        if (view.getUint32(at, true) === END_OF_CENTRAL_DIR)
            return at;
    }
    return -1;
}
const utf8 = new TextDecoder("utf-8");
/**
 * Every member of the archive, found through the central directory, so a file
 * with a prepended stub still reads correctly. Nothing is inflated until an
 * entry's `data()` is asked for.
 */
function readZip(bytes, opts) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEndRecord(view);
    if (end < 0)
        throw new ZipError("not a zip archive (no end-of-central-directory record)", "not-zip");
    const count = view.getUint16(end + 10, true);
    const directoryOffset = view.getUint32(end + 16, true);
    if (count === 0xffff || directoryOffset === 0xffffffff) {
        throw new ZipError("ZIP64 archives are not supported", "unsupported");
    }
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (count > maxEntries) {
        throw new ZipError(`archive has ${count} members; the limit is ${maxEntries}`, "too-large");
    }
    const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const entries = [];
    let at = directoryOffset;
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
            throw new ZipError("central directory is damaged", "corrupt");
        }
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const compressedSize = view.getUint32(at + 20, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new ZipError("ZIP64 archives are not supported", "unsupported");
        }
        const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
        // Bit 11 promises UTF-8; archives without it are almost always UTF-8 too,
        // and the decoder's replacement character is the right fallback for the rest.
        const path = normalisePath(utf8.decode(nameBytes));
        const isDirectory = path.endsWith("/");
        const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
        total += size;
        if (total > maxTotal) {
            throw new ZipError(`archive unpacks to more than ${formatBytes(maxTotal)} (declared ${formatBytes(total)} so far)`, "too-large");
        }
        entries.push({
            path,
            size,
            compressedSize,
            method,
            encrypted,
            isDirectory,
            data: () => readEntryData(bytes, view, opts.inflateRaw, { path, method, crc, compressedSize, size, localOffset, encrypted })
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}
function readEntryData(bytes, view, inflateRaw, entry) {
    if (entry.encrypted)
        throw new ZipError(`"${entry.path}" is encrypted`, "encrypted");
    const local = entry.localOffset;
    if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_FILE_HEADER) {
        throw new ZipError(`"${entry.path}" has no local header`, "corrupt");
    }
    // The local header repeats the name and extra fields, and its extra length
    // may differ from the central one, so the data offset has to be read here.
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const stop = start + entry.compressedSize;
    if (stop > bytes.length)
        throw new ZipError(`"${entry.path}" runs past the end of the archive`, "corrupt");
    const raw = bytes.subarray(start, stop);
    let out;
    if (entry.method === METHOD_STORED)
        out = raw.slice();
    else if (entry.method === METHOD_DEFLATE) {
        try {
            out = inflateRaw(raw, entry.size);
        }
        catch (error) {
            // An inflater may enforce a budget of its own and say so in our terms;
            // that verdict is final and must not be read as a damaged member.
            if (error instanceof ZipError)
                throw error;
            const detail = error instanceof Error ? error.message : String(error);
            const code = error?.code;
            if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large|exceed/i.test(detail)) {
                throw new ZipError(`"${entry.path}" inflates past its declared size of ${formatBytes(entry.size)}`, "too-large");
            }
            throw new ZipError(`"${entry.path}" could not be inflated (${detail})`, "corrupt");
        }
    }
    else
        throw new ZipError(`"${entry.path}" uses compression method ${entry.method}`, "unsupported");
    if (out.length !== entry.size) {
        throw new ZipError(`"${entry.path}" inflated to ${out.length} bytes, expected ${entry.size}`, "corrupt");
    }
    if (crc32(out) !== entry.crc)
        throw new ZipError(`"${entry.path}" failed its CRC check`, "corrupt");
    return out;
}
function normalisePath(name) {
    let path = name.replace(/\\/g, "/");
    while (path.startsWith("/"))
        path = path.slice(1);
    while (path.startsWith("./"))
        path = path.slice(2);
    return path;
}
const utf8Encoder = new TextEncoder();
/**
 * One archive from a list of files. Members are deflated when that is shorter
 * than storing them and a deflater was supplied; names are written as UTF-8
 * with the flag that says so, which every modern unzipper honours.
 */
function createZip(files, opts = {}) {
    if (files.length > 0xffff)
        throw new ZipError(`cannot write ${files.length} members without ZIP64`, "too-large");
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
        const path = normalisePath(file.path);
        const name = utf8Encoder.encode(path);
        const crc = crc32(file.data);
        let method = METHOD_STORED;
        let payload = file.data;
        if (opts.deflateRaw && file.data.length > 0) {
            const deflated = opts.deflateRaw(file.data);
            if (deflated.length < file.data.length) {
                method = METHOD_DEFLATE;
                payload = deflated;
            }
        }
        const { time, date } = dosDateTime(file.mtime ?? new Date());
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, LOCAL_FILE_HEADER, true);
        lv.setUint16(4, 20, true); // version needed: 2.0 (deflate)
        lv.setUint16(6, FLAG_UTF8_NAMES, true);
        lv.setUint16(8, method, true);
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, payload.length, true);
        lv.setUint32(22, file.data.length, true);
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);
        local.set(name, 30);
        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, CENTRAL_FILE_HEADER, true);
        cv.setUint16(4, 20, true); // version made by
        cv.setUint16(6, 20, true); // version needed
        cv.setUint16(8, FLAG_UTF8_NAMES, true);
        cv.setUint16(10, method, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, payload.length, true);
        cv.setUint32(24, file.data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, 0, true); // extra
        cv.setUint16(32, 0, true); // comment
        cv.setUint16(34, 0, true); // disk
        cv.setUint16(36, 0, true); // internal attributes
        cv.setUint32(38, 0, true); // external attributes
        cv.setUint32(42, offset, true);
        central.set(name, 46);
        locals.push(local, payload);
        centrals.push(central);
        offset += local.length + payload.length;
        if (offset > 0xffffffff)
            throw new ZipError("archive would exceed 4 GB without ZIP64", "too-large");
    }
    const directoryOffset = offset;
    const directorySize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, END_OF_CENTRAL_DIR, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, directorySize, true);
    ev.setUint32(16, directoryOffset, true);
    ev.setUint16(20, 0, true);
    return concat([...locals, ...centrals, eocd]);
}
function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
function dosDateTime(d) {
    const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}
let crcTable;
/** CRC-32 as ZIP uses it (IEEE 802.3, reflected, pre/post-inverted). */
function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
