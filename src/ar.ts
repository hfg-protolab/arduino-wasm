/**
 * GNU `ar` archives: a writer that produces the same bytes as binutils' `ar rcsD`
 * (deterministic headers, GNU "/" symbol index, "//" long-name table) and a minimal reader.
 * Browser-safe (Uint8Array/DataView/TextEncoder only).
 *
 * Layout written (as binutils' _bfd_write_archive_contents does it):
 *   "!<arch>\n"
 *   "/"  symbol index  (if any)      — big-endian count, member header offsets, NUL-terminated names
 *   "//" long-name table (if needed) — "name/\n" per member whose name is longer than 15 bytes
 *   members, each `name/` or `/<offset into //>`, data padded to an even size with "\n"
 */

import { ElfFile, SHN_COMMON, SHN_UNDEF, STB_GLOBAL, STB_WEAK } from "./elf";

export interface ArMember {
    name: string;
    data: Uint8Array;
}

export interface ArIndexEntry {
    symbol: string;
    /** Index into `members`. */
    member: number;
}

export type ArSymbolSource = "elf" | "none" | ((m: ArMember) => string[]);

export class ArError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ArError";
    }
}

const MAGIC = "!<arch>\n";
const HDR = 60;
/** binutils: ar_max_namelen of the ELF targets; longer names go to the "//" table. */
const MAX_SHORT_NAME = 15;
/** STB_GNU_UNIQUE (STB_LOOS); bfd maps it to BSF_GNU_UNIQUE, which the index includes. */
const STB_GNU_UNIQUE = 10;
const LTO_SYMTAB_PREFIX = ".gnu.lto_.symtab.";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

/**
 * Global symbols for the archive index of one member, in the order GNU ar/ranlib emit them.
 *
 * Plain ELF object (bfd `_bfd_compute_and_write_armap` over `elf_slurp_symbol_table`):
 * every symbol table entry after the null symbol, in table order, that is not undefined
 * (st_shndx != SHN_UNDEF) and is either STB_GLOBAL, STB_WEAK, STB_GNU_UNIQUE or lives in
 * SHN_COMMON. SHN_ABS and other reserved section indexes count as defined. Locals, section
 * and file symbols are skipped.
 *
 * GCC LTO object (has a `.gnu.lto_.symtab.*` section): the symbols the LTO plugin reports,
 * i.e. what `<arch>-gcc-ar` / `gcc-ranlib` write: entries of kind DEF, WEAKDEF or COMMON in
 * LTO-symtab order, UNDEF/WEAKUNDEF skipped. The placeholder ELF symbols (`__gnu_lto_v1`,
 * `__gnu_lto_slim`) are not listed, as with the plugin. A plain `ar` without the plugin would
 * list only those placeholders, which makes the linker never pull the member.
 *
 * Anything that is not a little-endian ELF32 file contributes no symbols (and does not count
 * as an object for the "is there an index at all" decision).
 */
export function archiveSymbols(data: Uint8Array): string[] | null {
    let elf: ElfFile;
    try {
        elf = new ElfFile(data);
    } catch {
        return null;
    }
    const lto = elf.sections.filter((s) => s.name.startsWith(LTO_SYMTAB_PREFIX));
    if (lto.length > 0) {
        const out: string[] = [];
        for (const s of lto) out.push(...ltoSymtabDefined(elf.sectionData(s)));
        return out;
    }
    const out: string[] = [];
    const syms = elf.symbols();
    for (let i = 1; i < syms.length; i++) {
        const s = syms[i]!;
        if (s.shndx === SHN_UNDEF) continue;
        if (s.bind === STB_GLOBAL || s.bind === STB_WEAK || s.bind === STB_GNU_UNIQUE || s.shndx === SHN_COMMON) {
            out.push(s.name);
        }
    }
    return out;
}

/**
 * Defined symbols of a GCC LTO symbol table section (format read by gcc/lto-plugin's
 * parse_table_entry): name\0 comdat\0 kind:u8 visibility:u8 size:u64 slot:u32.
 * kind: 0 DEF, 1 WEAKDEF, 2 UNDEF, 3 WEAKUNDEF, 4 COMMON.
 */
function ltoSymtabDefined(d: Uint8Array): string[] {
    const out: string[] = [];
    let p = 0;
    while (p < d.length) {
        let e = p;
        while (e < d.length && d[e] !== 0) e++;
        const name = dec.decode(d.subarray(p, e));
        p = e + 1;
        while (p < d.length && d[p] !== 0) p++; // comdat key
        p++;
        if (p + 14 > d.length) throw new ArError("truncated LTO symbol table");
        const kind = d[p]!;
        p += 14;
        if (kind === 0 || kind === 1 || kind === 4) out.push(name);
    }
    return out;
}

function field(s: string, width: number): string {
    if (s.length > width) throw new ArError(`ar header field "${s}" exceeds ${width} bytes`);
    return s + " ".repeat(width - s.length);
}

function header(name: string, date: string, uid: string, gid: string, mode: string, size: number): string {
    return field(name, 16) + field(date, 12) + field(uid, 6) + field(gid, 6) + field(mode, 8) + field(String(size), 10) + "`\n";
}

/**
 * GNU ar archive with a symbol index ("/" member, like `ar rcsD`), members in the given order.
 *
 * `symbols`: "elf" (default) derives the index like GNU ar/gcc-ar (see `archiveSymbols`) and
 * writes it when at least one member is an ELF object; "none" writes no index (like `ar rcSD`);
 * a function supplies each member's index symbols and always writes an index.
 *
 * Member names are used verbatim (basename, no "/"); duplicates are kept as separate members.
 */
export function writeArchive(members: ArMember[], opts?: { symbols?: ArSymbolSource }): Uint8Array {
    const source = opts?.symbols ?? "elf";

    // Member names and the "//" long-name table.
    const nameFields: string[] = [];
    let longNames = "";
    for (const m of members) {
        if (m.name.length === 0 || m.name.includes("/") || m.name.includes("\n")) {
            throw new ArError(`invalid ar member name "${m.name}"`);
        }
        const bytes = enc.encode(m.name);
        if (bytes.length > MAX_SHORT_NAME) {
            nameFields.push("/" + enc.encode(longNames).length);
            longNames += m.name + "/\n";
        } else {
            nameFields.push(m.name + "/");
        }
    }
    const longBytes = enc.encode(longNames);
    const longPadded = longBytes.length + (longBytes.length & 1);

    // Symbol index content.
    let symsPerMember: string[][] | null = null;
    if (source !== "none") {
        let hasObjects = typeof source === "function";
        symsPerMember = members.map((m) => {
            if (typeof source === "function") return source(m);
            const s = archiveSymbols(m.data);
            if (s) hasObjects = true;
            return s ?? [];
        });
        if (!hasObjects) symsPerMember = null;
    }

    let mapSize = 0;
    let mapStrings: Uint8Array[] = [];
    let mapCount = 0;
    if (symsPerMember) {
        mapStrings = symsPerMember.map((list) => enc.encode(list.map((s) => s + "\0").join("")));
        mapCount = symsPerMember.reduce((n, l) => n + l.length, 0);
        const strSize = mapStrings.reduce((n, b) => n + b.length, 0);
        mapSize = 4 + 4 * mapCount + strSize;
        mapSize += mapSize & 1;
    }

    // Member header offsets.
    let offset = MAGIC.length + (symsPerMember ? HDR + mapSize : 0) + (longBytes.length ? HDR + longPadded : 0);
    const offsets: number[] = [];
    for (const m of members) {
        offsets.push(offset);
        offset += HDR + m.data.length + (m.data.length & 1);
    }
    if (offset > 0xffffffff) throw new ArError("archive too large for a 32-bit symbol index");

    const out = new Uint8Array(offset);
    const view = new DataView(out.buffer);
    let p = 0;
    const put = (s: string | Uint8Array) => {
        const b = typeof s === "string" ? enc.encode(s) : s;
        out.set(b, p);
        p += b.length;
    };

    put(MAGIC);
    if (symsPerMember) {
        // _bfd_coff_write_armap: date 0 (deterministic), uid/gid 0, mode 0.
        put(header("/", "0", "0", "0", "0", mapSize));
        const start = p;
        view.setUint32(p, mapCount);
        p += 4;
        symsPerMember.forEach((list, i) => {
            for (let k = 0; k < list.length; k++) {
                view.setUint32(p, offsets[i]!);
                p += 4;
            }
        });
        for (const b of mapStrings) put(b);
        p = start + mapSize; // odd size padded with a NUL (buffer is zeroed)
    }
    if (longBytes.length) {
        // Long-name table header: only name and size, every other field blank.
        put(field("//", 16) + " ".repeat(32) + field(String(longPadded), 10) + "`\n");
        put(longBytes);
        if (longBytes.length & 1) put("\n");
    }
    members.forEach((m, i) => {
        // `ar D`: mtime 0, uid 0, gid 0, mode 0644.
        put(header(nameFields[i]!, "0", "0", "0", "644", m.data.length));
        put(m.data);
        if (m.data.length & 1) put("\n");
    });
    return out;
}

function headerText(bytes: Uint8Array, at: number, len: number): string {
    return String.fromCharCode(...bytes.subarray(at, at + len)).trimEnd();
}

/**
 * Minimal reader: members in archive order (GNU "//" long names and BSD "#1/" names resolved),
 * plus the parsed "/" symbol index if present. Member data are views into `bytes`.
 */
export function readArchive(bytes: Uint8Array): { members: ArMember[]; index?: ArIndexEntry[] } {
    if (bytes.length < MAGIC.length || headerText(bytes, 0, 8) + "\n" !== MAGIC) {
        if (headerText(bytes, 0, 8) === "!<thin>") throw new ArError("thin archives are not supported");
        throw new ArError("not an ar archive");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const members: ArMember[] = [];
    const memberAt = new Map<number, number>();
    let rawIndex: Array<{ symbol: string; offset: number }> | undefined;
    let longNames: Uint8Array | undefined;

    let p = MAGIC.length;
    while (p < bytes.length) {
        if (bytes[p] === 0x0a && p + 1 === bytes.length) break; // stray final pad
        if (p + HDR > bytes.length) throw new ArError(`truncated member header at ${p}`);
        if (bytes[p + 58] !== 0x60 || bytes[p + 59] !== 0x0a) throw new ArError(`bad member header at ${p}`);
        const rawName = headerText(bytes, p, 16);
        const size = Number.parseInt(headerText(bytes, p + 48, 10), 10);
        if (!Number.isFinite(size) || size < 0) throw new ArError(`bad member size at ${p}`);
        let dataStart = p + HDR;
        let dataEnd = dataStart + size;
        if (dataEnd > bytes.length) throw new ArError(`member at ${p} out of bounds`);
        const headerOffset = p;
        p = dataEnd + (size & 1);

        if (rawName === "/" || rawName === "/SYM64/") {
            const w = rawName === "/" ? 4 : 8;
            const read = (o: number) => (w === 4 ? view.getUint32(o) : Number(view.getBigUint64(o)));
            const count = read(dataStart);
            let q = dataStart + w;
            const offs: number[] = [];
            for (let i = 0; i < count; i++, q += w) offs.push(read(q));
            rawIndex = [];
            for (const o of offs) {
                let e = q;
                while (e < dataEnd && bytes[e] !== 0) e++;
                rawIndex.push({ symbol: dec.decode(bytes.subarray(q, e)), offset: o });
                q = e + 1;
            }
            continue;
        }
        if (rawName === "//") {
            longNames = bytes.subarray(dataStart, dataEnd);
            continue;
        }
        if (rawName === "__.SYMDEF" || rawName === "__.SYMDEF SORTED") continue; // BSD index, not parsed

        let name: string;
        if (/^\/\d+$/.test(rawName)) {
            if (!longNames) throw new ArError("long member name without a // table");
            const o = Number(rawName.slice(1));
            let e = o;
            while (e < longNames.length && longNames[e] !== 0x0a) e++;
            name = dec.decode(longNames.subarray(o, e));
            if (name.endsWith("/")) name = name.slice(0, -1);
        } else if (rawName.startsWith("#1/")) {
            const n = Number(rawName.slice(3));
            let e = dataStart;
            while (e < dataStart + n && bytes[e] !== 0) e++;
            name = dec.decode(bytes.subarray(dataStart, e));
            dataStart += n;
        } else {
            name = dec.decode(bytes.subarray(headerOffset, headerOffset + 16)).trimEnd();
            if (name.endsWith("/")) name = name.slice(0, -1);
        }
        memberAt.set(headerOffset, members.length);
        members.push({ name, data: bytes.subarray(dataStart, dataEnd) });
    }

    if (!rawIndex) return { members };
    const index = rawIndex.map(({ symbol, offset }) => {
        const member = memberAt.get(offset);
        if (member === undefined) throw new ArError(`index entry ${symbol} points to no member (offset ${offset})`);
        return { symbol, member };
    });
    return { members, index };
}
