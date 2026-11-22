/**
 * `.tar.gz` reading for registry packages, following Python's `gzip` and `tarfile` modules
 * (what PlatformIO 6.2 unpacks packages with):
 *
 * - gzip: several concatenated members are one stream, zero padding between/after members is
 *   skipped, anything else after a member is an error. Inflating is left to
 *   `DecompressionStream("gzip")`; since implementations differ on what they do after the first
 *   member, member boundaries are found by checking each member's CRC32/ISIZE trailer.
 * - tar: ustar names with `prefix`, GNU long names (`././@LongLink`, type `L`), pax headers
 *   (`x` for the next member, `g` for all following ones; `path=` and `size=` are applied).
 *   An all-zero block ends the archive; a broken header ends it too unless it is the first one
 *   (tarfile's `next()`), a broken header after a long-name/pax header is an error.
 * - Only regular files (and unknown types, which tarfile extracts as files) are returned;
 *   directories, links, devices and FIFOs are skipped. Absolute paths and `..` components throw.
 */

export interface TarEntry {
    path: string;
    data: Uint8Array;
}

// --- gzip -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function u32le(data: Uint8Array, at: number): number {
    return (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24)) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/** Runs `DecompressionStream("gzip")`; `null` when it reports an error. */
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const parts: Uint8Array[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
        }
    } catch {
        return null;
    }
    return parts.length ? concat(parts) : new Uint8Array(0);
}

/** Does the member ending at `end` carry the CRC32 and size of `out` in its trailer? */
function trailerMatches(data: Uint8Array, end: number, out: Uint8Array): boolean {
    return end >= 18 && u32le(data, end - 4) === out.length >>> 0 && u32le(data, end - 8) === crc32(out);
}

const isMemberStart = (data: Uint8Array, p: number) =>
    data[p] === 0x1f && data[p + 1] === 0x8b && data[p + 2] === 0x08 && ((data[p + 3] ?? 0xff) & 0xe0) === 0;

/** Inflates the member starting at `start`; returns its output and end offset. */
async function inflateMember(data: Uint8Array, start: number): Promise<{ out: Uint8Array; end: number }> {
    const ends: number[] = [];
    for (let p = start + 18; p < data.length - 1; p++) if (isMemberStart(data, p)) ends.push(p);
    ends.push(data.length);
    for (const boundary of ends) {
        // The member may be followed by zero padding; its trailer ends within 8 bytes after the
        // last non-zero byte before `boundary`.
        let lastNonZero = boundary - 1;
        while (lastNonZero >= start && data[lastNonZero] === 0) lastNonZero--;
        const candidates = new Set([boundary]);
        for (let e = lastNonZero + 1; e <= Math.min(boundary, lastNonZero + 9); e++) candidates.add(e);
        for (const end of candidates) {
            if (end - start < 18) continue;
            const out = await inflate(data.subarray(start, end));
            if (out && trailerMatches(data, end, out)) return { out, end };
        }
    }
    throw new Error("gzip: invalid or truncated member");
}

/** `gzip.decompress`: all members, zero padding skipped. */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
    if (!data.length) return new Uint8Array(0);
    if (data[0] !== 0x1f || data[1] !== 0x8b) throw new Error("Not a gzipped file");
    const whole = await inflate(data);
    if (whole && trailerMatches(data, data.length, whole)) return whole;

    const parts: Uint8Array[] = [];
    let start = 0;
    while (start < data.length) {
        if (parts.length) {
            while (start < data.length && data[start] === 0) start++;
            if (start >= data.length) break;
            if (data[start] !== 0x1f || data[start + 1] !== 0x8b) throw new Error("Not a gzipped file");
        }
        const { out, end } = await inflateMember(data, start);
        parts.push(out);
        start = end;
    }
    return concat(parts);
}

// --- tar --------------------------------------------------------------------------------------

const BLOCK = 512;
const block = (n: number) => Math.ceil(n / BLOCK) * BLOCK;
const REGULAR = new Set(["0", "\0", "7", "S"]);
const SUPPORTED = new Set(["0", "\0", "1", "2", "5", "6", "7", "3", "4", "L", "K", "S"]);

class HeaderError extends Error {
    constructor(
        readonly kind: "eof" | "empty" | "truncated" | "invalid",
        message: string,
    ) {
        super(message);
    }
}

const utf8 = new TextDecoder("utf-8");

/** `tarfile.nts`: bytes up to the first NUL. */
function nts(b: Uint8Array): string {
    const z = b.indexOf(0);
    return utf8.decode(z < 0 ? b : b.subarray(0, z));
}

/** `tarfile.nti`: octal, or GNU base-256 when the first byte is 0x80/0xff. */
function nti(b: Uint8Array): number {
    if (b[0] === 0o200 || b[0] === 0o377) {
        let n = 0;
        for (let i = 1; i < b.length; i++) n = n * 256 + b[i]!;
        return b[0] === 0o377 ? -(256 ** (b.length - 1) - n) : n;
    }
    const s = nts(b).trim();
    if (!/^[+-]?[0-7]*$/.test(s)) throw new HeaderError("invalid", "invalid header");
    return s.replace(/^[+-]$/, "") ? parseInt(s, 8) : 0;
}

interface Info {
    name: string;
    type: string;
    size: number;
    offsetData: number;
}

function isDir(i: Info): boolean {
    return i.type === "5";
}

/** `TarInfo.frombuf`. */
function frombuf(data: Uint8Array, at: number): Info {
    const buf = data.subarray(at, at + BLOCK);
    if (!buf.length) throw new HeaderError("empty", "empty header");
    if (buf.length !== BLOCK) throw new HeaderError("truncated", "truncated header");
    if (buf.every((b) => b === 0)) throw new HeaderError("eof", "end of file header");
    const chksum = nti(buf.subarray(148, 156));
    let unsigned = 256;
    let signed = 256;
    for (let i = 0; i < BLOCK; i++) {
        if (i >= 148 && i < 156) continue;
        unsigned += buf[i]!;
        signed += buf[i]! < 128 ? buf[i]! : buf[i]! - 256;
    }
    if (chksum !== unsigned && chksum !== signed) throw new HeaderError("invalid", "bad checksum");
    const info: Info = { name: nts(buf.subarray(0, 100)), type: String.fromCharCode(buf[156]!), size: nti(buf.subarray(124, 136)), offsetData: 0 };
    const prefix = nts(buf.subarray(345, 500));
    if (info.type === "\0" && info.name.endsWith("/")) info.type = "5";
    if (info.type === "S") throw new Error("tar: GNU sparse files are not supported");
    if (isDir(info)) info.name = info.name.replace(/\/+$/, "");
    if (prefix && !["L", "K", "S"].includes(info.type)) info.name = `${prefix}/${info.name}`;
    return info;
}

type Pax = Map<string, string>;

/** Parses pax records `"%d %s=%s\n"`. */
function parsePax(buf: Uint8Array, into: Pax): void {
    let pos = 0;
    while (pos < buf.length && buf[pos] !== 0) {
        let p = pos;
        while (p < buf.length && p - pos < 20 && buf[p]! >= 0x30 && buf[p]! <= 0x39) p++;
        if (p === pos || buf[p] !== 0x20) throw new HeaderError("invalid", "invalid header");
        const length = Number(utf8.decode(buf.subarray(pos, p)));
        if (length < 5 || pos + length > buf.length) throw new HeaderError("invalid", "invalid header");
        const last = pos + length - 1;
        const kv = buf.subarray(p + 1, last);
        const eq = kv.indexOf(0x3d);
        if (eq <= 0 || buf[last] !== 0x0a) throw new HeaderError("invalid", "invalid header");
        into.set(utf8.decode(kv.subarray(0, eq)), utf8.decode(kv.subarray(eq + 1)));
        pos += length;
    }
}

/** `TarInfo._apply_pax_info` for the fields that matter here. */
function applyPax(info: Info, pax: Pax): void {
    for (const [k, v] of pax) {
        if (k === "path" || k === "GNU.sparse.name") info.name = k === "path" ? v.replace(/\/+$/, "") : v;
        else if (k === "size" || k === "GNU.sparse.size" || k === "GNU.sparse.realsize") info.size = /^\s*[+-]?\d+\s*$/.test(v) ? Number(v) : 0;
    }
}

interface Ctx {
    data: Uint8Array;
    globalPax: Pax;
}

/** `TarInfo.fromtarfile` + `_proc_member`: the member whose header is at `at`, and the next offset. */
function member(ctx: Ctx, at: number): { info: Info; next: number } {
    const info = frombuf(ctx.data, at);
    const dataAt = at + BLOCK;
    const subsequent = (off: number) => {
        try {
            return member(ctx, off);
        } catch (e) {
            if (e instanceof HeaderError) throw new Error(`tar: ${e.message}`);
            throw e;
        }
    };
    if (info.type === "L" || info.type === "K") {
        const buf = ctx.data.subarray(dataAt, dataAt + block(info.size));
        const next = subsequent(dataAt + block(info.size));
        if (info.type === "L") next.info.name = nts(buf);
        if (isDir(next.info)) next.info.name = next.info.name.replace(/\/$/, "");
        return next;
    }
    if (info.type === "x" || info.type === "g" || info.type === "X") {
        const buf = ctx.data.subarray(dataAt, dataAt + block(info.size));
        const pax: Pax = info.type === "g" ? ctx.globalPax : new Map(ctx.globalPax);
        parsePax(buf, pax);
        const next = subsequent(dataAt + block(info.size));
        if (info.type !== "g") {
            applyPax(next.info, pax);
            if (pax.has("size")) {
                next.next = next.info.offsetData;
                if (REGULAR.has(next.info.type) || !SUPPORTED.has(next.info.type)) next.next += block(next.info.size);
            }
        }
        return next;
    }
    info.offsetData = dataAt;
    let next = dataAt;
    if (REGULAR.has(info.type) || !SUPPORTED.has(info.type)) next += block(info.size);
    applyPax(info, ctx.globalPax);
    if (isDir(info)) info.name = info.name.replace(/\/+$/, "");
    return { info, next };
}

/** `a/./b`, `./a` → `a/b`, `a`; absolute paths and `..` throw. */
function normalisePath(name: string): string {
    if (name.startsWith("/")) throw new Error(`tar: absolute path ${JSON.stringify(name)}`);
    const parts = name.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.includes("..")) throw new Error(`tar: path outside the archive ${JSON.stringify(name)}`);
    return parts.join("/");
}

/** Regular files of an (uncompressed) tar archive; a later entry with the same path wins. */
export function readTar(data: Uint8Array): TarEntry[] {
    const ctx: Ctx = { data, globalPax: new Map() };
    const out = new Map<string, TarEntry>();
    let offset = 0;
    for (;;) {
        let m: { info: Info; next: number };
        try {
            m = member(ctx, offset);
        } catch (e) {
            if (!(e instanceof HeaderError)) throw e;
            if (e.kind === "eof") break;
            if (offset === 0) throw new Error(e.kind === "empty" ? "tar: empty file" : `tar: ${e.message}`);
            break;
        }
        const { info } = m;
        if (REGULAR.has(info.type) || !SUPPORTED.has(info.type)) {
            const path = normalisePath(info.name);
            if (info.offsetData + info.size > data.length) throw new Error("tar: unexpected end of data");
            if (path) {
                out.delete(path);
                out.set(path, { path, data: data.slice(info.offsetData, info.offsetData + info.size) });
            }
        }
        offset = m.next;
    }
    return [...out.values()];
}

/** Hex SHA-256 of the bytes (the registry's archive checksum). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
