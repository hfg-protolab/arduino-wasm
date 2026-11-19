/**
 * GNU ar archives (the format of every .a in the AVR and ESP32 toolchains): read members and
 * the armap ("/" member, the symbol index ld searches), write a new archive from a subset of
 * members with its armap. Phase 0 spike; the browser runtime will reuse this unchanged.
 *
 * Layout: "!<arch>\n", then per member a 60-byte header (name[16] date[12] uid[6] gid[6]
 * mode[8] size[10] "`\n") and the data padded to an even length with "\n". Special members:
 * "/" = armap (u32be count, u32be header offsets, NUL-terminated names), "//" = long names
 * ("name/\n" entries, referenced as "/<offset>").
 */

export interface ArMember {
    name: string;
    /** Byte offset of the member header in the archive (what the armap points at). */
    headerOffset: number;
    data: Uint8Array;
}

export interface ArArchive {
    members: ArMember[];
    /** armap in file order: symbol → index into `members`. */
    armap: Array<{ symbol: string; member: number }>;
}

const MAGIC = "!<arch>\n";
const dec = new TextDecoder("latin1");

export function readArchive(buf: Uint8Array): ArArchive {
    if (dec.decode(buf.subarray(0, 8)) !== MAGIC) throw new Error("not a GNU ar archive");
    const members: ArMember[] = [];
    let rawArmap: Uint8Array | null = null;
    let longNames = "";
    let off = 8;
    while (off + 60 <= buf.length) {
        const hdr = dec.decode(buf.subarray(off, off + 60));
        const rawName = hdr.slice(0, 16).trimEnd();
        const size = parseInt(hdr.slice(48, 58).trim(), 10);
        const data = buf.subarray(off + 60, off + 60 + size);
        if (rawName === "/") rawArmap = data;
        else if (rawName === "//") longNames = dec.decode(data);
        else if (rawName === "/SYM64/") throw new Error("64-bit armap not supported");
        else {
            let name = rawName;
            if (/^\/\d+$/.test(name)) {
                const s = parseInt(name.slice(1), 10);
                name = longNames.slice(s, longNames.indexOf("/\n", s));
            } else if (name.endsWith("/")) name = name.slice(0, -1);
            members.push({ name, headerOffset: off, data });
        }
        off += 60 + size + (size & 1);
    }
    const armap: ArArchive["armap"] = [];
    if (rawArmap) {
        const dv = new DataView(rawArmap.buffer, rawArmap.byteOffset, rawArmap.byteLength);
        const n = dv.getUint32(0);
        const byOffset = new Map(members.map((m, i) => [m.headerOffset, i]));
        let p = 4 + 4 * n;
        for (let i = 0; i < n; i++) {
            const end = rawArmap.indexOf(0, p);
            const symbol = dec.decode(rawArmap.subarray(p, end));
            p = end + 1;
            const member = byOffset.get(dv.getUint32(4 + 4 * i));
            if (member === undefined) throw new Error(`armap points at no member: ${symbol}`);
            armap.push({ symbol, member });
        }
    }
    return { members, armap };
}

function field(s: string, width: number): string {
    if (s.length > width) throw new Error(`ar field too long: ${s}`);
    return s.padEnd(width, " ");
}

function header(name: string, size: number): string {
    // Deterministic like `ar D`: date 0, uid 0, gid 0, mode 644.
    return field(name, 16) + field("0", 12) + field("0", 6) + field("0", 6) + field("644", 8) + field(String(size), 10) + "`\n";
}

/**
 * Writes an archive with `members` (in that order) and an armap holding `armap` (in that
 * order; `member` indexes into `members`). Long names go to a "//" table like GNU ar does.
 */
export function writeArchive(members: Array<{ name: string; data: Uint8Array }>, armap: Array<{ symbol: string; member: number }>): Uint8Array {
    const enc = new TextEncoder();
    // Long-name table.
    let longNames = "";
    const nameField = members.map((m) => {
        if (m.name.length + 1 <= 16 && !m.name.includes("/")) return m.name + "/";
        const ref = "/" + longNames.length;
        longNames += m.name + "/\n";
        return ref;
    });
    const symBytes = armap.map((a) => enc.encode(a.symbol + "\0"));
    let symLen = symBytes.reduce((n, b) => n + b.length, 0);
    let armapSize = 4 + 4 * armap.length + symLen;
    const armapPad = armapSize & 1;
    if (armapPad) { symLen += 1; armapSize += 1; } // GNU pads the string table itself
    const longBytes = enc.encode(longNames);
    const longPad = longBytes.length & 1;

    // Member header offsets.
    let off = 8;
    if (armap.length) off += 60 + armapSize;
    if (longBytes.length) off += 60 + longBytes.length + longPad;
    const offsets: number[] = [];
    for (const m of members) {
        offsets.push(off);
        off += 60 + m.data.length + (m.data.length & 1);
    }

    const out = new Uint8Array(off);
    let p = 0;
    const put = (b: Uint8Array) => { out.set(b, p); p += b.length; };
    const putStr = (s: string) => put(enc.encode(s));
    putStr(MAGIC);
    if (armap.length) {
        putStr(header("/", armapSize));
        const dv = new DataView(out.buffer, p, 4 + 4 * armap.length);
        dv.setUint32(0, armap.length);
        armap.forEach((a, i) => dv.setUint32(4 + 4 * i, offsets[a.member]));
        p += 4 + 4 * armap.length;
        for (const b of symBytes) put(b);
        if (armapPad) out[p++] = 0;
    }
    if (longBytes.length) {
        putStr(header("//", longBytes.length));
        put(longBytes);
        if (longPad) out[p++] = 0x0a;
    }
    members.forEach((m, i) => {
        putStr(header(nameField[i], m.data.length));
        put(m.data);
        if (m.data.length & 1) out[p++] = 0x0a;
    });
    return out;
}
