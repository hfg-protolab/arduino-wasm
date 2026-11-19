/**
 * ELF → Intel HEX, byte-identical to `avr-objcopy -O ihex -R .eeprom firmware.elf firmware.hex`
 * as PlatformIO's atmelavr builder runs it (binutils bfd/ihex.c):
 * - every loadable section (SHF_ALLOC, not NOBITS, non-empty, not removed) at its LMA,
 *   one chunk per section, chunks sorted by address (stable);
 * - 16 data bytes per record, records never cross a 64 KiB boundary;
 * - type 02 (extended segment address) for addresses up to 0xFFFFF, type 04 above;
 * - a start record (03/05) only when e_entry != 0; EOF record; "\r\n" line ends, uppercase hex.
 */
import { ElfFile, PT_LOAD, SHF_ALLOC, SHT_NOBITS, type ElfSection } from "./elf";

export interface ElfToHexOptions {
    /** Sections left out (objcopy `-R`). Default [".eeprom"]. */
    remove?: string[];
}

/** Load address of a section, as BFD derives it from the PT_LOAD program headers. */
export function sectionLma(elf: ElfFile, s: ElfSection): number {
    let lma = s.addr;
    for (const p of elf.programHeaders) {
        if (p.type !== PT_LOAD) continue;
        const inFile = s.type === SHT_NOBITS || (s.offset >= p.offset && s.offset + s.size <= p.offset + p.filesz);
        const inMem = s.addr >= p.vaddr && s.addr + s.size <= p.vaddr + p.memsz;
        if (!inFile || !inMem) continue;
        lma = s.type === SHT_NOBITS ? p.paddr + s.addr - p.vaddr : p.paddr + s.offset - p.offset;
        break;
    }
    return lma >>> 0;
}

const hex2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, "0");

function record(type: number, addr: number, data: ArrayLike<number>): string {
    let sum = data.length + ((addr >> 8) & 0xff) + (addr & 0xff) + type;
    let s = ":" + hex2(data.length) + hex2(addr >> 8) + hex2(addr) + hex2(type);
    for (let i = 0; i < data.length; i++) {
        sum += data[i]!;
        s += hex2(data[i]!);
    }
    return s + hex2(-sum) + "\r\n";
}

export function elfToIntelHex(elf: ElfFile | Uint8Array, opts: ElfToHexOptions = {}): string {
    const e = elf instanceof ElfFile ? elf : new ElfFile(elf);
    const remove = new Set(opts.remove ?? [".eeprom"]);
    const chunks: Array<{ where: number; data: Uint8Array }> = [];
    for (const s of e.sections) {
        if (!(s.flags & SHF_ALLOC) || s.type === SHT_NOBITS || s.size === 0 || remove.has(s.name)) continue;
        const c = { where: sectionLma(e, s), data: e.sectionData(s) };
        // ihex_set_section_contents: insert before the first chunk with a higher address
        const at = chunks.findIndex((x) => x.where > c.where);
        if (at < 0) chunks.push(c);
        else chunks.splice(at, 0, c);
    }

    const out: string[] = [];
    let segbase = 0;
    let extbase = 0;
    for (const c of chunks) {
        let where = c.where;
        let p = 0;
        let count = c.data.length;
        while (count > 0) {
            let now = Math.min(count, 16);
            if (where > segbase + extbase + 0xffff) {
                if (where <= 0xfffff) {
                    segbase = where & 0xf0000;
                    out.push(record(2, 0, [(segbase >> 12) & 0xff, (segbase >> 4) & 0xff]));
                } else {
                    if (segbase !== 0) {
                        out.push(record(2, 0, [0, 0]));
                        segbase = 0;
                    }
                    extbase = (where & 0xffff0000) >>> 0;
                    out.push(record(4, 0, [(extbase >>> 24) & 0xff, (extbase >>> 16) & 0xff]));
                }
            }
            const recAddr = where - (extbase + segbase);
            if (recAddr + now > 0xffff) now = 0x10000 - recAddr;
            out.push(record(0, recAddr, c.data.subarray(p, p + now)));
            where += now;
            p += now;
            count -= now;
        }
    }
    const start = e.header.entry >>> 0;
    if (start !== 0) {
        if (start <= 0xfffff) out.push(record(3, 0, [((start & 0xf0000) >> 12) & 0xff, 0, (start >> 8) & 0xff, start & 0xff]));
        else out.push(record(5, 0, [(start >>> 24) & 0xff, (start >>> 16) & 0xff, (start >>> 8) & 0xff, start & 0xff]));
    }
    out.push(record(1, 0, []));
    return out.join("");
}
