/**
 * TypeScript port of esptool v4.11.0 `elf2image` for ESP32, ESP32-S3 and ESP32-C3
 * (esptool/cmds.py elf2image, esptool/bin_image.py ELFFile / ESP32FirmwareImage).
 * Produces byte-identical output to:
 *
 *   esptool.py --chip <chip> elf2image --flash_mode <m> --flash_freq <f> --flash_size <s>
 *              [--elf-sha256-offset <n>] -o out.bin in.elf
 *
 * with every other option at its argparse default:
 *   --version 1 (ignored for non-ESP8266), --min-rev 0, --min-rev-full 0, --max-rev-full 65535,
 *   no --secure-pad / --secure-pad-v2, append digest on, --use_segments off (ELF *sections* are used),
 *   no --flash-mmu-page-size, no --pad-to-size, no --ram-only-header.
 *
 * Code paths dropped because they are unreachable with these chips/options:
 *   - ESP8266 image formats (v1/v2/v3).
 *   - MMU page size handling: --flash-mmu-page-size is never passed, and the app-desc based
 *     auto-detection only runs for chips with a configurable MMU page size (MMU_PAGE_SIZE_CONF,
 *     i.e. ESP32-C2/C6 family); for ESP32/S3/C3 IROM_ALIGN stays 64 KB.
 *   - --use_segments (ELF program headers): the image is always built from sections.
 *   - --ram-only-header (incl. its segment sorting and the reversed flash-segment layout).
 *   - --secure-pad / --secure-pad-v2 and --pad-to-size.
 *   - --dont-append-digest (the SHA-256 of the image is always appended).
 *
 * Browser-safe: Uint8Array/DataView only, SHA-256 via crypto.subtle.
 */

import { ElfFile } from "./elf";

export type EspChip = "esp32" | "esp32s3" | "esp32c3";

export interface ElfToImageOptions {
    chip: EspChip;
    flashMode: "qio" | "qout" | "dio" | "dout";
    /** "80m", "40m", "26m", "20m" (the encodings these chips support). */
    flashFreq: string;
    /** "1MB" … "128MB". */
    flashSize: string;
    /** --elf-sha256-offset: write the SHA-256 of the whole ELF file at this offset of the .bin. */
    elfSha256Offset?: number;
}

/** Board presets (PlatformIO espressif32@7.1.3 app image flags), keyed by our board ids. */
export const ESP_IMAGE_PRESETS: Record<"esp32dev" | "esp32-s3" | "esp32-c3", ElfToImageOptions> = {
    esp32dev: { chip: "esp32", flashMode: "dio", flashFreq: "40m", flashSize: "4MB", elfSha256Offset: 0xb0 },
    "esp32-s3": { chip: "esp32s3", flashMode: "dio", flashFreq: "80m", flashSize: "8MB", elfSha256Offset: 0xb0 },
    "esp32-c3": { chip: "esp32c3", flashMode: "dio", flashFreq: "80m", flashSize: "4MB", elfSha256Offset: 0xb0 },
};

// ---------------------------------------------------------------------------------------------
// Chip definitions (esptool/targets/esp32.py, esp32s3.py, esp32c3.py)

type MemoryRange = readonly [start: number, end: number, type: string];

interface ChipDef {
    /** ROM_LOADER.CHIP_NAME */
    name: string;
    imageChipId: number;
    iromMapStart: number;
    iromMapEnd: number;
    dromMapStart: number;
    dromMapEnd: number;
    memoryMap: readonly MemoryRange[];
}

// ESP32-S3 and ESP32-C3 inherit both tables from ESP32ROM.
const FLASH_SIZES: Record<string, number> = {
    "1MB": 0x00,
    "2MB": 0x10,
    "4MB": 0x20,
    "8MB": 0x30,
    "16MB": 0x40,
    "32MB": 0x50,
    "64MB": 0x60,
    "128MB": 0x70,
};

const FLASH_FREQUENCY: Record<string, number> = {
    "80m": 0xf,
    "40m": 0x0,
    "26m": 0x1,
    "20m": 0x2,
};

const FLASH_MODES: Record<ElfToImageOptions["flashMode"], number> = { qio: 0, qout: 1, dio: 2, dout: 3 };

const CHIPS: Record<EspChip, ChipDef> = {
    esp32: {
        name: "ESP32",
        imageChipId: 0,
        iromMapStart: 0x400d0000,
        iromMapEnd: 0x40400000,
        dromMapStart: 0x3f400000,
        dromMapEnd: 0x3f800000,
        memoryMap: [
            [0x00000000, 0x00010000, "PADDING"],
            [0x3f400000, 0x3f800000, "DROM"],
            [0x3f800000, 0x3fc00000, "EXTRAM_DATA"],
            [0x3ff80000, 0x3ff82000, "RTC_DRAM"],
            [0x3ff90000, 0x40000000, "BYTE_ACCESSIBLE"],
            [0x3ffae000, 0x40000000, "DRAM"],
            [0x3ffe0000, 0x3ffffffc, "DIRAM_DRAM"],
            [0x40000000, 0x40070000, "IROM"],
            [0x40070000, 0x40078000, "CACHE_PRO"],
            [0x40078000, 0x40080000, "CACHE_APP"],
            [0x40080000, 0x400a0000, "IRAM"],
            [0x400a0000, 0x400bfffc, "DIRAM_IRAM"],
            [0x400c0000, 0x400c2000, "RTC_IRAM"],
            [0x400d0000, 0x40400000, "IROM"],
            [0x50000000, 0x50002000, "RTC_DATA"],
        ],
    },
    esp32s3: {
        name: "ESP32-S3",
        imageChipId: 9,
        iromMapStart: 0x42000000,
        iromMapEnd: 0x44000000,
        dromMapStart: 0x3c000000,
        dromMapEnd: 0x3e000000,
        memoryMap: [
            [0x00000000, 0x00010000, "PADDING"],
            [0x3c000000, 0x3d000000, "DROM"],
            [0x3d000000, 0x3e000000, "EXTRAM_DATA"],
            [0x600fe000, 0x60100000, "RTC_DRAM"],
            [0x3fc88000, 0x3fd00000, "BYTE_ACCESSIBLE"],
            [0x3fc88000, 0x403e2000, "MEM_INTERNAL"],
            [0x3fc88000, 0x3fd00000, "DRAM"],
            [0x40000000, 0x4001a100, "IROM_MASK"],
            [0x40370000, 0x403e0000, "IRAM"],
            [0x600fe000, 0x60100000, "RTC_IRAM"],
            [0x42000000, 0x42800000, "IROM"],
            [0x50000000, 0x50002000, "RTC_DATA"],
        ],
    },
    esp32c3: {
        name: "ESP32-C3",
        imageChipId: 5,
        iromMapStart: 0x42000000,
        iromMapEnd: 0x42800000,
        dromMapStart: 0x3c000000,
        dromMapEnd: 0x3c800000,
        memoryMap: [
            [0x00000000, 0x00010000, "PADDING"],
            [0x3c000000, 0x3c800000, "DROM"],
            [0x3fc80000, 0x3fce0000, "DRAM"],
            [0x3fc88000, 0x3fd00000, "BYTE_ACCESSIBLE"],
            [0x3ff00000, 0x3ff20000, "DROM_MASK"],
            [0x40000000, 0x40060000, "IROM_MASK"],
            [0x42000000, 0x42800000, "IROM"],
            [0x4037c000, 0x403e0000, "IRAM"],
            [0x50000000, 0x50002000, "RTC_IRAM"],
            [0x50000000, 0x50002000, "RTC_DRAM"],
            [0x600fe000, 0x60100000, "MEM_INTERNAL2"],
        ],
    },
};

// ---------------------------------------------------------------------------------------------
// Constants (esptool/loader.py, bin_image.py)

const ESP_IMAGE_MAGIC = 0xe9;
const ESP_CHECKSUM_MAGIC = 0xef;
const SEG_HEADER_LEN = 8;
const SHA256_DIGEST_LEN = 32;
/** ESP32FirmwareImage.IROM_ALIGN (64 KB MMU pages; not configurable on these chips). */
const IROM_ALIGN = 0x10000;
const WP_PIN_DISABLED = 0xee;
const MIN_REV = 0;
const MIN_REV_FULL = 0;
const MAX_REV_FULL = 65535;
const SIXTEEN_MB = 0x1000000;

const SEC_TYPE_PROGBITS = 0x01;
const SEC_TYPE_STRTAB = 0x03;
const SEC_TYPE_NOBITS = 0x08;
const SEC_TYPE_INITARRAY = 0x0e;
const SEC_TYPE_FINIARRAY = 0x0f;
const SEC_TYPE_PREINITARRAY = 0x10;
const PROG_SEC_TYPES = new Set([SEC_TYPE_PROGBITS, SEC_TYPE_INITARRAY, SEC_TYPE_FINIARRAY, SEC_TYPE_PREINITARRAY]);
const KNOWN_SEC_TYPES = new Set([...PROG_SEC_TYPES, SEC_TYPE_NOBITS, SEC_TYPE_STRTAB]);

// ---------------------------------------------------------------------------------------------
// Image segments

/** ImageSegment / ELFSection. `name` is set for ELF sections only. */
interface Segment {
    addr: number;
    data: Uint8Array;
    name?: string;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** util.pad_to with NUL padding. */
function padTo(data: Uint8Array, alignment: number): Uint8Array {
    const mod = data.length % alignment;
    return mod === 0 ? data : concat(data, new Uint8Array(alignment - mod));
}

/** ImageSegment constructor: every segment with addr != 0 is padded to a 4-byte length. */
function makeSegment(addr: number, data: Uint8Array, name?: string): Segment {
    return { addr, data: addr !== 0 ? padTo(data, 4) : data, name };
}

/** ImageSegment.split_image: cut `len` bytes off the front; the rest stays in `seg`. */
function splitImage(seg: Segment, len: number): Segment {
    const result: Segment = { addr: seg.addr, data: seg.data.subarray(0, len), name: seg.name };
    seg.data = seg.data.subarray(len);
    seg.addr += len;
    return result;
}

function memoryTypes(chip: ChipDef, addr: number): string {
    // Python compares the lists of matching types; joining them preserves that equality.
    return chip.memoryMap
        .filter(([start, end]) => start <= addr && addr < end)
        .map(([, , type]) => type)
        .join("\0");
}

function checksum(data: Uint8Array, state: number): number {
    for (let i = 0; i < data.length; i++) state ^= data[i]!;
    return state;
}

/** ELFFile._read_sections: the sections that become image segments, in section header order. */
function readSections(elf: ElfFile): Segment[] {
    const h = elf.header;
    if (h.machine !== 0x5e && h.machine !== 0xf3) {
        throw new Error(
            `input does not appear to be an Xtensa or an RISCV ELF file. e_machine=${h.machine.toString(16).padStart(4, "0")}`,
        );
    }
    if (h.shentsize !== 0x28) {
        throw new Error(`ELF has unexpected section header entry size 0x${h.shentsize.toString(16)} (not 0x28)`);
    }
    if (h.shnum === 0) throw new Error("ELF has 0 section headers");
    if (h.shstrndx >= h.shnum) throw new Error(`ELF file has no STRTAB section at shstrndx ${h.shstrndx}`);

    const out: Segment[] = [];
    for (const s of elf.sections) {
        // Skip sections with lma == 0 or size == 0 (sh_addr is what esptool calls lma).
        if (s.addr === 0 || s.size === 0) continue;
        // Unknown types only produce a warning in esptool; NOBITS (.bss etc.) and STRTAB never
        // become segments.
        if (!KNOWN_SEC_TYPES.has(s.type) || !PROG_SEC_TYPES.has(s.type)) continue;
        // Python: f.read(size), which may come back short for a truncated file.
        const data = elf.bytes.subarray(s.offset, Math.min(s.offset + s.size, elf.bytes.length));
        out.push(makeSegment(s.addr, data, s.name));
    }
    return out;
}

/** BaseFirmwareImage.merge_adjacent_segments (keeps ELF order; merges only within one memory type). */
function mergeAdjacentSegments(chip: ChipDef, segs: Segment[]): Segment[] {
    if (segs.length === 0) return segs;
    const result: Segment[] = [];
    for (let i = segs.length - 1; i > 0; i--) {
        const elem = segs[i - 1]!;
        const next = segs[i]!;
        if (memoryTypes(chip, elem.addr) === memoryTypes(chip, next.addr) && next.addr === elem.addr + elem.data.length) {
            elem.data = concat(elem.data, next.data);
        } else {
            result.unshift(next);
        }
    }
    result.unshift(segs[0]!);
    return result;
}

// ---------------------------------------------------------------------------------------------
// Output buffer with BytesIO-like seek semantics

class ByteWriter {
    private buf = new Uint8Array(0x10000);
    private len = 0;
    pos = 0;

    private ensure(n: number): void {
        if (n <= this.buf.length) return;
        let cap = this.buf.length;
        while (cap < n) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }

    write(data: Uint8Array | number[]): void {
        const end = this.pos + data.length;
        this.ensure(end);
        // Seeking past the end and writing zero-fills the gap (buffer is zero-initialised).
        this.buf.set(data, this.pos);
        this.pos = end;
        if (end > this.len) this.len = end;
    }

    u8(v: number): void {
        this.write([v & 0xff]);
    }
    u16(v: number): void {
        this.write([v & 0xff, (v >>> 8) & 0xff]);
    }
    u32(v: number): void {
        this.write([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
    }

    bytes(): Uint8Array {
        return this.buf.slice(0, this.len);
    }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
    // Copy into a fresh ArrayBuffer-backed array so SubtleCrypto accepts any input view.
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
}

// ---------------------------------------------------------------------------------------------
// elf2image

export async function elfToEspImage(elfBytes: Uint8Array, opts: ElfToImageOptions): Promise<Uint8Array> {
    const chip = CHIPS[opts.chip];
    if (!chip) throw new Error(`unsupported chip: ${String(opts.chip)}`);
    const flashMode = FLASH_MODES[opts.flashMode];
    if (flashMode === undefined) throw new Error(`unsupported flash mode: ${String(opts.flashMode)}`);
    const sizeCode = FLASH_SIZES[opts.flashSize];
    if (sizeCode === undefined) {
        throw new Error(`Flash size '${opts.flashSize}' is not supported by this chip type. Supported sizes: ${Object.keys(FLASH_SIZES).join(", ")}`);
    }
    const freqCode = FLASH_FREQUENCY[opts.flashFreq];
    if (freqCode === undefined) {
        throw new Error(
            `Flash frequency '${opts.flashFreq}' is not supported by this chip type. Supported frequencies: ${Object.keys(FLASH_FREQUENCY).join(", ")}`,
        );
    }

    const elf = new ElfFile(elfBytes);
    const isFlashAddr = (addr: number) =>
        (chip.iromMapStart <= addr && addr < chip.iromMapEnd) || (chip.dromMapStart <= addr && addr < chip.dromMapEnd);

    let segments = readSections(elf);
    const flashSizeFreq = sizeCode + freqCode;

    let elfSha256: Uint8Array | null = null;
    let elfSha256Offset = 0;
    if (opts.elfSha256Offset) {
        elfSha256 = await sha256(elfBytes);
        elfSha256Offset = opts.elfSha256Offset;
    } else {
        // No explicit offset: if the ELF has a flash-mapped app_desc section, esptool puts the
        // digest at 0xB0 anyway.
        const appdesc = segments.find((s) => s.name!.includes(".flash.appdesc"));
        if (appdesc && isFlashAddr(appdesc.addr)) {
            elfSha256 = await sha256(elfBytes);
            elfSha256Offset = 0xb0;
        }
    }

    segments = mergeAdjacentSegments(chip, segments);
    if (segments.length > 16) {
        throw new Error(`Invalid segment count ${segments.length} (max 16). Usually this indicates a linker script problem.`);
    }

    // ---- ESP32FirmwareImage.save
    const f = new ByteWriter();
    // common header (segment count is patched at the end)
    f.u8(ESP_IMAGE_MAGIC);
    f.u8(segments.length);
    f.u8(flashMode);
    f.u8(flashSizeFreq);
    f.u32(elf.header.entry);
    // extended header "<BBBBHBHH" + "BBBB" + "B"
    f.u8(WP_PIN_DISABLED);
    f.u8(0); // clk_drv | q_drv << 4
    f.u8(0); // d_drv | cs_drv << 4
    f.u8(0); // hd_drv | wp_drv << 4
    f.u16(chip.imageChipId);
    f.u8(MIN_REV);
    f.u16(MIN_REV_FULL);
    f.u16(MAX_REV_FULL);
    f.write([0, 0, 0, 0]);
    f.u8(1); // append_digest

    let csum = ESP_CHECKSUM_MAGIC;

    // Stable sort by address, then split into flash-mapped vs RAM-loaded (copies, as they get mutated).
    const sorted = [...segments].sort((a, b) => a.addr - b.addr);
    const clone = (s: Segment): Segment => ({ addr: s.addr, data: s.data, name: s.name });
    const flashSegments = sorted.filter((s) => isFlashAddr(s.addr)).map(clone);
    const ramSegments = sorted.filter((s) => !isFlashAddr(s.addr)).map(clone);

    // Move ".flash.appdesc" to the top of the flash segments (ESP32-C6 union bus memmap patch).
    const appdescIdx = flashSegments.findIndex((s) => s.name === ".flash.appdesc");
    if (appdescIdx >= 0) flashSegments.unshift(...flashSegments.splice(appdescIdx, 1));
    // Bootloader: move ".dram0.bootdesc" to the top of the RAM segments.
    const bootdescIdx = ramSegments.findIndex((s) => s.name === ".dram0.bootdesc");
    if (bootdescIdx >= 0) ramSegments.unshift(...ramSegments.splice(bootdescIdx, 1));

    // Two ELF sections in the same 64 KB flash page cannot be mapped.
    if (flashSegments.length > 0) {
        let lastAddr = flashSegments[0]!.addr;
        for (const seg of flashSegments.slice(1)) {
            if (Math.floor(seg.addr / IROM_ALIGN) === Math.floor(lastAddr / IROM_ALIGN)) {
                throw new Error(
                    `Segment loaded at ${hex8(seg.addr)} lands in same ${IROM_ALIGN / 1024} KB flash mapping as segment loaded at ${hex8(lastAddr)}. ` +
                        "Can't generate binary. Suggest changing linker script or ELF to merge sections.",
                );
            }
            lastAddr = seg.addr;
        }
    }

    const maybePatchSegmentData = (data: Uint8Array): Uint8Array => {
        const filePos = f.pos;
        if (elfSha256 && elfSha256Offset >= filePos && elfSha256Offset < filePos + data.length) {
            let patchOffset = elfSha256Offset - filePos;
            if (patchOffset < SEG_HEADER_LEN || patchOffset + SHA256_DIGEST_LEN > data.length) {
                throw new Error(
                    `Cannot place SHA256 digest on segment boundary(elf_sha256_offset=${elfSha256Offset}, file_pos=${filePos}, segment_size=${data.length})`,
                );
            }
            patchOffset -= SEG_HEADER_LEN;
            if (data.subarray(patchOffset, patchOffset + SHA256_DIGEST_LEN).some((b) => b !== 0)) {
                throw new Error(
                    `Contents of segment at SHA256 digest offset 0x${elfSha256Offset.toString(16)} are not all zero. Refusing to overwrite.`,
                );
            }
            const patched = new Uint8Array(data);
            patched.set(elfSha256, patchOffset);
            return patched;
        }
        return data;
    };

    const saveSegment = (seg: Segment, segmentName?: string): void => {
        const data = maybePatchSegmentData(seg.data);
        const name = segmentName ?? "";
        if (data.length & 3) {
            throw new Error(`Invalid ${name} segment length 0x${data.length.toString(16)}. It has to be multiple of 4.`);
        }
        if (data.length >= SIXTEEN_MB) {
            throw new Error(`Invalid ${name} segment length 0x${data.length.toString(16)}. The 16 MB limit has been exceeded.`);
        }
        f.u32(seg.addr);
        f.u32(data.length);
        f.write(data);
        csum = checksum(data, csum);
    };

    const saveFlashSegment = (seg: Segment): void => {
        if (chip.name === "ESP32") {
            // Work around an ESP-IDF 2nd stage bootloader bug: it didn't map the last MMU page
            // if an IROM/DROM segment was < 0x24 bytes over the page boundary.
            const segmentEndPos = f.pos + seg.data.length + SEG_HEADER_LEN;
            const remainder = segmentEndPos % IROM_ALIGN;
            if (remainder < 0x24) seg.data = concat(seg.data, new Uint8Array(0x24 - remainder));
        }
        saveSegment(seg, seg.name);
    };

    // Padding needed so that, after the next 8-byte header, file_offs % IROM_ALIGN == addr % IROM_ALIGN.
    const alignmentDataNeeded = (seg: Segment): number => {
        const alignPast = (seg.addr % IROM_ALIGN) - SEG_HEADER_LEN;
        let padLen = IROM_ALIGN - (f.pos % IROM_ALIGN) + alignPast;
        if (padLen === 0 || padLen === IROM_ALIGN) return 0;
        // the padding block has a header as well
        padLen -= SEG_HEADER_LEN;
        if (padLen < 0) padLen += IROM_ALIGN;
        return padLen;
    };

    let totalSegments = 0;
    // Fit each flash segment on an MMU-page aligned boundary, padding with parts of RAM segments.
    while (flashSegments.length > 0) {
        const seg = flashSegments[0]!;
        const padLen = alignmentDataNeeded(seg);
        if (padLen > 0) {
            let pad: Segment;
            if (ramSegments.length > 0 && padLen > SEG_HEADER_LEN) {
                pad = splitImage(ramSegments[0]!, padLen);
                if (ramSegments[0]!.data.length === 0) ramSegments.shift();
            } else {
                pad = { addr: 0, data: new Uint8Array(padLen) };
            }
            saveSegment(pad, seg.name);
            totalSegments++;
        } else {
            if ((f.pos + 8) % IROM_ALIGN !== seg.addr % IROM_ALIGN) throw new Error("flash segment misaligned");
            saveFlashSegment(seg);
            flashSegments.shift();
            totalSegments++;
        }
    }
    for (const seg of ramSegments) {
        saveSegment(seg, seg.name);
        totalSegments++;
    }

    // append_checksum: checksum in the last byte of a 16-byte aligned block
    f.pos += 15 - (f.pos % 16);
    f.u8(csum);
    const imageLength = f.pos;

    // Patch the segment count (including padding segments); the header is not checksummed.
    f.pos = 1;
    f.u8(totalSegments);

    // Append the SHA-256 of the whole image.
    const image = f.bytes().subarray(0, imageLength);
    const digest = await sha256(image);
    const out = new Uint8Array(imageLength + SHA256_DIGEST_LEN);
    out.set(image, 0);
    out.set(digest, imageLength);
    return out;
}

function hex8(n: number): string {
    return "0x" + n.toString(16).padStart(8, "0");
}
