/**
 * Minimal ELF32 little-endian reader: header, section headers, program headers, symbols.
 * Enough for Intel HEX, esptool's elf2image, the size report and the symbol index.
 * Browser-safe (Uint8Array/DataView only).
 */

export const SHT_NULL = 0;
export const SHT_PROGBITS = 1;
export const SHT_SYMTAB = 2;
export const SHT_STRTAB = 3;
export const SHT_RELA = 4;
export const SHT_NOBITS = 8;
export const SHT_REL = 9;
export const SHT_INIT_ARRAY = 14;
export const SHT_FINI_ARRAY = 15;
export const SHT_PREINIT_ARRAY = 16;

export const SHF_WRITE = 0x1;
export const SHF_ALLOC = 0x2;
export const SHF_EXECINSTR = 0x4;

export const PT_NULL = 0;
export const PT_LOAD = 1;

export const STB_LOCAL = 0;
export const STB_GLOBAL = 1;
export const STB_WEAK = 2;

export const SHN_UNDEF = 0;
export const SHN_ABS = 0xfff1;
export const SHN_COMMON = 0xfff2;

export const EM_AVR = 83;
export const EM_XTENSA = 94;
export const EM_RISCV = 243;

export class ElfError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ElfError";
    }
}

export interface ElfHeader {
    type: number;
    machine: number;
    version: number;
    entry: number;
    phoff: number;
    shoff: number;
    flags: number;
    ehsize: number;
    phentsize: number;
    phnum: number;
    shentsize: number;
    shnum: number;
    shstrndx: number;
}

export interface ElfSection {
    index: number;
    name: string;
    type: number;
    flags: number;
    addr: number;
    offset: number;
    size: number;
    link: number;
    info: number;
    addralign: number;
    entsize: number;
}

export interface ElfProgramHeader {
    index: number;
    type: number;
    offset: number;
    vaddr: number;
    paddr: number;
    filesz: number;
    memsz: number;
    flags: number;
    align: number;
}

export interface ElfSymbol {
    name: string;
    value: number;
    size: number;
    info: number;
    /** STB_* */
    bind: number;
    /** STT_* */
    type: number;
    other: number;
    shndx: number;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** NUL-terminated string at `offset` (latin-1 safe for plain ASCII names, UTF-8 otherwise). */
export function cString(bytes: Uint8Array, offset: number): string {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(offset, end));
}

export class ElfFile {
    readonly bytes: Uint8Array;
    readonly header: ElfHeader;
    readonly sections: ElfSection[];
    readonly programHeaders: ElfProgramHeader[];
    private readonly view: DataView;
    private symbolCache?: ElfSymbol[];

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
            throw new ElfError("not an ELF file");
        }
        if (bytes[4] !== 1) throw new ElfError("only ELF32 is supported");
        if (bytes[5] !== 1) throw new ElfError("only little-endian ELF is supported");
        const v = this.view;
        this.header = {
            type: v.getUint16(16, true),
            machine: v.getUint16(18, true),
            version: v.getUint32(20, true),
            entry: v.getUint32(24, true),
            phoff: v.getUint32(28, true),
            shoff: v.getUint32(32, true),
            flags: v.getUint32(36, true),
            ehsize: v.getUint16(40, true),
            phentsize: v.getUint16(42, true),
            phnum: v.getUint16(44, true),
            shentsize: v.getUint16(46, true),
            shnum: v.getUint16(48, true),
            shstrndx: v.getUint16(50, true),
        };
        this.sections = this.readSections();
        this.programHeaders = this.readProgramHeaders();
    }

    private readSections(): ElfSection[] {
        const h = this.header;
        if (h.shoff === 0 || h.shnum === 0) return [];
        if (h.shentsize < 40) throw new ElfError("section header entry too small");
        if (h.shoff + h.shnum * h.shentsize > this.bytes.length) throw new ElfError("section headers out of bounds");
        const raw: Array<Omit<ElfSection, "name"> & { nameOff: number }> = [];
        for (let i = 0; i < h.shnum; i++) {
            const o = h.shoff + i * h.shentsize;
            const v = this.view;
            raw.push({
                index: i,
                nameOff: v.getUint32(o, true),
                type: v.getUint32(o + 4, true),
                flags: v.getUint32(o + 8, true),
                addr: v.getUint32(o + 12, true),
                offset: v.getUint32(o + 16, true),
                size: v.getUint32(o + 20, true),
                link: v.getUint32(o + 24, true),
                info: v.getUint32(o + 28, true),
                addralign: v.getUint32(o + 32, true),
                entsize: v.getUint32(o + 36, true),
            });
        }
        const strtab = raw[h.shstrndx];
        return raw.map(({ nameOff, ...s }) => ({
            ...s,
            name: strtab && strtab.type !== SHT_NOBITS ? cString(this.bytes, strtab.offset + nameOff) : "",
        }));
    }

    private readProgramHeaders(): ElfProgramHeader[] {
        const h = this.header;
        if (h.phoff === 0 || h.phnum === 0) return [];
        if (h.phentsize < 32) throw new ElfError("program header entry too small");
        if (h.phoff + h.phnum * h.phentsize > this.bytes.length) throw new ElfError("program headers out of bounds");
        const out: ElfProgramHeader[] = [];
        for (let i = 0; i < h.phnum; i++) {
            const o = h.phoff + i * h.phentsize;
            const v = this.view;
            out.push({
                index: i,
                type: v.getUint32(o, true),
                offset: v.getUint32(o + 4, true),
                vaddr: v.getUint32(o + 8, true),
                paddr: v.getUint32(o + 12, true),
                filesz: v.getUint32(o + 16, true),
                memsz: v.getUint32(o + 20, true),
                flags: v.getUint32(o + 24, true),
                align: v.getUint32(o + 28, true),
            });
        }
        return out;
    }

    /** The first section with this name. */
    section(name: string): ElfSection | undefined {
        return this.sections.find((s) => s.name === name);
    }

    /** File contents of a section (empty for SHT_NOBITS). A view, not a copy. */
    sectionData(s: ElfSection): Uint8Array {
        if (s.type === SHT_NOBITS || s.size === 0) return new Uint8Array(0);
        if (s.offset + s.size > this.bytes.length) throw new ElfError(`section ${s.name} out of bounds`);
        return this.bytes.subarray(s.offset, s.offset + s.size);
    }

    /** File contents of a segment (`filesz` bytes). A view, not a copy. */
    segmentData(p: ElfProgramHeader): Uint8Array {
        if (p.offset + p.filesz > this.bytes.length) throw new ElfError(`segment ${p.index} out of bounds`);
        return this.bytes.subarray(p.offset, p.offset + p.filesz);
    }

    /** All entries of the first SHT_SYMTAB (index 0, the null symbol, included). */
    symbols(): ElfSymbol[] {
        if (this.symbolCache) return this.symbolCache;
        const symtab = this.sections.find((s) => s.type === SHT_SYMTAB);
        if (!symtab) return (this.symbolCache = []);
        const strtab = this.sections[symtab.link];
        const entsize = symtab.entsize || 16;
        const out: ElfSymbol[] = [];
        const v = this.view;
        for (let o = symtab.offset; o + 16 <= symtab.offset + symtab.size; o += entsize) {
            const info = this.bytes[o + 12]!;
            out.push({
                name: strtab ? cString(this.bytes, strtab.offset + v.getUint32(o, true)) : "",
                value: v.getUint32(o + 4, true),
                size: v.getUint32(o + 8, true),
                info,
                bind: info >> 4,
                type: info & 0xf,
                other: this.bytes[o + 13]!,
                shndx: v.getUint16(o + 14, true),
            });
        }
        return (this.symbolCache = out);
    }

    /** The first symbol with this name. */
    symbol(name: string): ElfSymbol | undefined {
        return this.symbols().find((s) => s.name === name);
    }
}

export function parseElf(bytes: Uint8Array): ElfFile {
    return new ElfFile(bytes);
}
