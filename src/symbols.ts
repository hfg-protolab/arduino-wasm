/**
 * Global symbols of an ELF32 little-endian relocatable object (AVR, Xtensa, RISC-V), classified
 * the way archive resolution needs them: what a member defines (strong, weak, common) and what
 * it references (strong or weak undefined). Browser-safe.
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
const STB_GNU_UNIQUE = 10;
const STT_SECTION = 3;
const STT_FILE = 4;

const dec = new TextDecoder("latin1");

function cstr(buf: Uint8Array, off: number): string {
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return dec.decode(buf.subarray(off, e));
}

export function isElf32Le(buf: Uint8Array): boolean {
    return buf.length > 52 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46 && buf[4] === 1 && buf[5] === 1;
}

export function elfSymbols(buf: Uint8Array): ObjSymbol[] {
    if (!isElf32Le(buf)) throw new Error("not an ELF32 little-endian object");
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
            const info = buf[s + 12]!;
            const bind = info >> 4;
            const type = info & 0xf;
            if (bind !== STB_GLOBAL && bind !== STB_WEAK && bind !== STB_GNU_UNIQUE) continue;
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
