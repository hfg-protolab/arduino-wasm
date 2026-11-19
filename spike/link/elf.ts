/**
 * Global symbols of an ELF32 relocatable object (AVR, Xtensa, RISC-V: all little-endian
 * ELF32). Enough for archive resolution: which symbols a member defines (strong, weak,
 * common) and which it references (strong or weak undefined).
 */

export type SymKind = "def" | "weakdef" | "common" | "undef" | "weakundef";

export interface ObjSymbol {
    name: string;
    kind: SymKind;
}

const SHT_SYMTAB = 2;
const SHN_UNDEF = 0;
const SHN_COMMON = 0xfff2;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const STT_SECTION = 3;
const STT_FILE = 4;

const dec = new TextDecoder("latin1");

function cstr(buf: Uint8Array, off: number): string {
    let e = off;
    while (buf[e] !== 0) e++;
    return dec.decode(buf.subarray(off, e));
}

/** True for a GCC LTO "slim" object: its ELF symtab does not describe the code. */
export function isLtoObject(buf: Uint8Array): boolean {
    return elfSymbols(buf).some((s) => s.name === "__gnu_lto_slim" || s.name === "__gnu_lto_v1");
}

export function elfSymbols(buf: Uint8Array): ObjSymbol[] {
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) throw new Error("not ELF");
    if (buf[4] !== 1 || buf[5] !== 1) throw new Error("only ELF32 little-endian");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const shoff = dv.getUint32(0x20, true);
    const shentsize = dv.getUint16(0x2e, true);
    const shnum = dv.getUint16(0x30, true);
    const out: ObjSymbol[] = [];
    for (let i = 0; i < shnum; i++) {
        const sh = shoff + i * shentsize;
        if (dv.getUint32(sh + 4, true) !== SHT_SYMTAB) continue;
        const off = dv.getUint32(sh + 16, true);
        const size = dv.getUint32(sh + 20, true);
        const link = dv.getUint32(sh + 24, true);
        const firstGlobal = dv.getUint32(sh + 28, true);
        const strOff = dv.getUint32(shoff + link * shentsize + 16, true);
        for (let s = off + 16 * firstGlobal; s < off + size; s += 16) {
            const info = buf[s + 12];
            const bind = info >> 4;
            const type = info & 0xf;
            if (bind !== STB_GLOBAL && bind !== STB_WEAK) continue;
            if (type === STT_SECTION || type === STT_FILE) continue;
            const shndx = dv.getUint16(s + 14, true);
            const name = cstr(buf, strOff + dv.getUint32(s, true));
            if (!name) continue;
            let kind: SymKind;
            if (shndx === SHN_UNDEF) kind = bind === STB_WEAK ? "weakundef" : "undef";
            else if (shndx === SHN_COMMON) kind = "common";
            else kind = bind === STB_WEAK ? "weakdef" : "def";
            out.push({ name, kind });
        }
    }
    return out;
}

/** Parses `nm -P` output of one object (used for LTO objects via <prefix>gcc-nm). */
export function nmSymbols(text: string): ObjSymbol[] {
    const out: ObjSymbol[] = [];
    for (const line of text.split("\n")) {
        const [name, t] = line.trim().split(/\s+/);
        if (!name || !t) continue;
        let kind: SymKind | null = null;
        if (t === "U") kind = "undef";
        else if (t === "w" || t === "v") kind = "weakundef";
        else if (t === "W" || t === "V") kind = "weakdef";
        else if (t === "C") kind = "common";
        else if (/^[TDBRAGSI]$/.test(t)) kind = "def";
        if (kind) out.push({ name, kind });
    }
    return out;
}
