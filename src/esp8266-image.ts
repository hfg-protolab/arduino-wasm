/**
 * TypeScript port of ESP8266 Arduino core 3.1.2 `tools/elf2bin.py`
 * (framework-arduinoespressif8266 3.30102.0, as used by PlatformIO espressif8266@4.2.1).
 * Produces byte-identical output to:
 *
 *   python elf2bin.py --eboot eboot.elf --app firmware.elf --flash_mode <m> --flash_freq <f>
 *                     --flash_size <s> --path <toolchain bin> --out firmware.bin
 *
 * Layout of the result (all little-endian):
 *   1. eboot image ("v1" ESP8266 image of eboot.elf, sections .text, .rodata), padded with 0xAA
 *      to exactly 4096 bytes.
 *   2. app image at offset 0x1000 (sections .irom0.text, .text, .text1, .data, .rodata, in that order).
 *   Each image: 8-byte header [0xE9, segment count, flash mode, freq | size << 4, entry u32];
 *   per section an 8-byte header [addr (VMA) u32, size u32] followed by the raw section bytes;
 *   then zero padding so that (image length + 1) is a multiple of 16, then one checksum byte
 *   (0xEF XOR every section data byte).
 *   3. Finally a CRC-32 (MSB-first, poly 0x04C11DB7, init 0xFFFFFFFF, no final XOR) over the whole
 *      file, computed with the words at 0x1010 and 0x1014 zeroed, then the file length is stored at
 *      0x1010 and the CRC at 0x1014. These are the first 8 bytes of .irom0.text's data: the linker
 *      script (tools/sdk/ld/eagle.app.v6.common.ld.h) reserves them as `__crc_len` / `__crc_val`,
 *      read back by ESP.checkFlashCRC() in Esp.cpp. elf2bin itself hard-codes the offsets, it does
 *      not look up the symbols; the app ELF must therefore start .irom0.text with those words.
 *
 * Replaced subprocess calls (the Python shells out to the Xtensa binutils):
 *   - `readelf -h` "Entry point address" -> ELF header e_entry.
 *   - `objdump -h -j <sec>` Size / VMA columns -> section header sh_size / sh_addr (first section
 *     with that exact name).
 *   - `objcopy -O binary --only-section=<sec>` -> the section's file contents. For the ALLOC +
 *     PROGBITS sections used here that is exactly sh_size bytes at sh_offset. A missing section or
 *     an SHT_NOBITS one makes the Python fail (objdump finds nothing / objcopy output length
 *     != size); we throw in both cases too.
 *
 * Fixed / dropped:
 *   - --gzip (PIO/Arduino gzipped output) is not ported; PlatformIO doesn't pass it by default.
 *   - Python's `total_size + 8 > to_addr` overflow check for eboot is kept verbatim (it is
 *     stricter than necessary by 8 bytes).
 *   - No symbols are looked up; only the section names above and e_entry.
 *
 * Browser-safe: Uint8Array/DataView only.
 */

import { ElfFile, SHT_NOBITS } from "./elf";

export interface Esp8266ImageOptions {
    flashMode: "qio" | "qout" | "dio" | "dout";
    flashFreq: "40" | "26" | "20" | "80";
    /** As elf2bin's --flash_size: "256K", "512K", "1M", "2M", "4M", "8M", "16M". */
    flashSize: string;
}

const FMODE: Record<string, number> = { dout: 3, dio: 2, qout: 1, qio: 0 };
const FFREQ: Record<string, number> = { "40": 0, "26": 1, "20": 2, "80": 15 };
const FSIZE: Record<string, number> = { "512K": 0, "256K": 1, "1M": 2, "2M": 3, "4M": 4, "8M": 8, "16M": 9 };

const EBOOT_SECTIONS = [".text", ".rodata"];
const APP_SECTIONS = [".irom0.text", ".text", ".text1", ".data", ".rodata"];
const EBOOT_SIZE = 4096;
const CRCSIZE_OFFSET = 4096 + 16;
const CRCVAL_OFFSET = 4096 + 16 + 4;

export class Esp8266ImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "Esp8266ImageError";
    }
}

class ByteWriter {
    private buf = new Uint8Array(1 << 16);
    length = 0;

    private ensure(extra: number): void {
        if (this.length + extra <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < this.length + extra) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
    }

    bytes(data: ArrayLike<number>): void {
        this.ensure(data.length);
        this.buf.set(data, this.length);
        this.length += data.length;
    }

    fill(value: number, count: number): void {
        this.ensure(count);
        this.buf.fill(value, this.length, this.length + count);
        this.length += count;
    }

    result(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

function u32le(v: number): number[] {
    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}

/** elf2bin.py write_bin(). */
function writeBin(out: ByteWriter, elf: ElfFile, what: string, sections: string[], toAddr: number, opts: Esp8266ImageOptions): void {
    const mode = FMODE[opts.flashMode];
    const freq = FFREQ[opts.flashFreq];
    const size = FSIZE[opts.flashSize];
    if (mode === undefined) throw new Esp8266ImageError(`unknown flash mode '${opts.flashMode}'`);
    if (freq === undefined) throw new Esp8266ImageError(`unknown flash frequency '${opts.flashFreq}'`);
    if (size === undefined) throw new Esp8266ImageError(`unknown flash size '${opts.flashSize}'`);

    const entry = elf.header.entry;
    out.bytes([0xe9, sections.length, mode, freq + 16 * size, ...u32le(entry)]);
    let totalSize = 8;
    let checksum = 0xef;
    for (const name of sections) {
        const sec = elf.section(name);
        if (!sec) throw new Esp8266ImageError(`Unable to find size and start point in ${what} for "${name}"`);
        if (sec.type === SHT_NOBITS) throw new Esp8266ImageError(`Segment size doesn't match read data for "${name}" in ${what}`);
        const raw = elf.sectionData(sec);
        out.bytes([...u32le(sec.addr), ...u32le(sec.size)]);
        totalSize += 8;
        out.bytes(raw);
        totalSize += raw.length;
        for (let i = 0; i < raw.length; i++) checksum ^= raw[i]!;
    }
    totalSize += 1;
    const pad = (16 - (totalSize & 15)) & 15;
    out.fill(0, pad);
    totalSize += pad;
    out.bytes([checksum]);
    if (toAddr !== 0) {
        if (totalSize + 8 > toAddr) {
            throw new Esp8266ImageError(`Bin image of ${what} is too big! Actual size ${totalSize + 8}, target size ${toAddr}`);
        }
        out.fill(0xaa, toAddr - totalSize);
    }
}

let CRC_TABLE: Uint32Array | undefined;

/** elf2bin.py crc8266(): CRC-32/MPEG-2 (MSB-first, poly 0x04C11DB7, init ~0, no reflect, no xorout). */
export function crc8266(data: Uint8Array): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n << 24;
            for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]!) & 255]!) >>> 0;
    return crc >>> 0;
}

export function elfToEsp8266Image(appElf: Uint8Array, ebootElf: Uint8Array, opts: Esp8266ImageOptions): Uint8Array {
    const out = new ByteWriter();
    writeBin(out, new ElfFile(ebootElf), "eboot ELF", EBOOT_SECTIONS, EBOOT_SIZE, opts);
    writeBin(out, new ElfFile(appElf), "app ELF", APP_SECTIONS, 0, opts);
    const raw = out.result();

    // add_crc(): zero the two words (idempotence), CRC the whole file, store length and CRC.
    if (raw.length < CRCVAL_OFFSET + 4) throw new Esp8266ImageError("image too small for the CRC words");
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    view.setUint32(CRCSIZE_OFFSET, 0, true);
    view.setUint32(CRCVAL_OFFSET, 0, true);
    const crc = crc8266(raw);
    view.setUint32(CRCSIZE_OFFSET, raw.length, true);
    view.setUint32(CRCVAL_OFFSET, crc, true);
    return raw;
}
