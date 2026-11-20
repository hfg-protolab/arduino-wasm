/**
 * Size report as PlatformIO's `checkprogsize` prints it ("RAM: …", "Flash: …"):
 * `size -A -d firmware.elf`, then per platform a regex over each stripped line, summing group 1
 * (platformio/builder/tools/pioupload.py CheckUploadSize). The section list `size -A` prints is
 * the ELF section table, so the regexes reduce to exact section-name sets:
 *
 * atmelavr@5.3.0   SIZEPROGREGEXP ^(?:\.text|\.data|\.bootloader)\s+(\d+).*
 *                  SIZEDATAREGEXP ^(?:\.data|\.bss|\.noinit)\s+(\d+).*
 * espressif32 (7.1.3 and pioarduino 55.03.39, identical)
 *                  SIZEPROGREGEXP ^(?:\.iram0\.text|\.iram0\.vectors|\.dram0\.data|\.flash\.text|\.flash\.rodata|)\s+([0-9]+).*
 *                  SIZEDATAREGEXP ^(?:\.dram0\.data|\.dram0\.bss|\.noinit)\s+([0-9]+).*
 *                  (the empty alternative never matches: lines are stripped first)
 * espressif8266@4.2.1 SIZEPROGREGEXP ^(?:\.irom0\.text|\.text|\.text1|\.data|\.rodata|)\s+([0-9]+).*
 *                  SIZEDATAREGEXP ^(?:\.data|\.rodata|\.bss)\s+([0-9]+).*
 *
 * Maxima: board JSON `upload.maximum_size`/`maximum_ram_size`; on espressif32 the builder
 * replaces maximum_size with the app partition (factory/ota_0) of the board's partition table.
 */
import { ElfFile } from "./elf";
import type { FirmwareSize, KnownBoard } from "./types";

export type SizeFamily = "avr" | "esp32" | "esp8266";

export const SIZE_SECTIONS: Record<SizeFamily, { program: string[]; data: string[] }> = {
    avr: { program: [".text", ".data", ".bootloader"], data: [".data", ".bss", ".noinit"] },
    esp32: { program: [".iram0.text", ".iram0.vectors", ".dram0.data", ".flash.text", ".flash.rodata"], data: [".dram0.data", ".dram0.bss", ".noinit"] },
    esp8266: { program: [".irom0.text", ".text", ".text1", ".data", ".rodata"], data: [".data", ".rodata", ".bss"] },
};

/** flashMax/ramMax per board (atmelavr@5.3.0 / pioarduino 55.03.39 / espressif8266@4.2.1, default partitions). */
export const BOARD_LIMITS: Record<KnownBoard, { family: SizeFamily; flashMax: number; ramMax: number }> = {
    uno: { family: "avr", flashMax: 32256, ramMax: 2048 },
    nano: { family: "avr", flashMax: 30720, ramMax: 2048 },
    "nano-old": { family: "avr", flashMax: 30720, ramMax: 2048 },
    mega: { family: "avr", flashMax: 253952, ramMax: 8192 },
    leonardo: { family: "avr", flashMax: 28672, ramMax: 2560 },
    esp32dev: { family: "esp32", flashMax: 0x140000, ramMax: 327680 }, // default.csv app0
    "esp32-s3": { family: "esp32", flashMax: 0x330000, ramMax: 327680 }, // default_8MB.csv app0
    "esp32-c3": { family: "esp32", flashMax: 0x140000, ramMax: 327680 }, // default.csv app0
    "esp32-c6": { family: "esp32", flashMax: 0x140000, ramMax: 327680 }, // default.csv app0 (pioarduino: no default_8MB for the C6)
    "nano-esp32": { family: "esp32", flashMax: 0x300000, ramMax: 327680 }, // app3M_fat9M_fact512k_16MB.csv app0
    nodemcu: { family: "esp8266", flashMax: 1044464, ramMax: 81920 }, // eagle.flash.4m2m.ld irom0
    "d1-mini": { family: "esp8266", flashMax: 1044464, ramMax: 81920 },
};

/** Program and data bytes of an ELF by PlatformIO's rules. */
export function elfSizes(elf: ElfFile | Uint8Array, family: SizeFamily): { flash: number; ram: number } {
    const e = elf instanceof ElfFile ? elf : new ElfFile(elf);
    const rules = SIZE_SECTIONS[family];
    let flash = 0;
    let ram = 0;
    for (const s of e.sections) {
        if (s.index === 0) continue; // `size -A` does not list the null section
        if (rules.program.includes(s.name)) flash += s.size;
        if (rules.data.includes(s.name)) ram += s.size;
    }
    return { flash, ram };
}

export interface SizeLimits {
    family: SizeFamily;
    flashMax: number;
    ramMax: number;
}

export function sizeReport(elf: ElfFile | Uint8Array, board: KnownBoard | SizeLimits): FirmwareSize {
    const l = typeof board === "string" ? BOARD_LIMITS[board] : board;
    const { flash, ram } = elfSizes(elf, l.family);
    return { flash, flashMax: l.flashMax, ram, ramMax: l.ramMax };
}

/** PlatformIO's two lines, e.g. "RAM:   [=         ]   9.3% (used 190 bytes from 2048 bytes)". */
export function formatSizeReport(size: FirmwareSize): string {
    const bar = (value: number, total: number) => {
        const pct = value / total;
        // Python round(): banker's rounding
        const raw = 10 * pct;
        let blocks = Math.round(raw);
        if (Math.abs(raw % 1) === 0.5 && blocks % 2 !== 0) blocks -= 1;
        blocks = Math.min(blocks, 10);
        return `[${"=".repeat(Math.max(0, blocks)).padEnd(10)}] ${(" " + (pct * 100).toFixed(1) + "%").padStart(6)} (used ${value} bytes from ${total} bytes)`;
    };
    return `RAM:   ${bar(size.ram, size.ramMax)}\nFlash: ${bar(size.flash, size.flashMax)}`;
}

/** The checks PlatformIO makes after the size report (English, like its own messages). */
export function sizeProblems(size: FirmwareSize): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (size.ram > size.ramMax) warnings.push(`Warning! The data size (${size.ram} bytes) is greater than maximum allowed (${size.ramMax} bytes)`);
    if (size.flash > size.flashMax) errors.push(`Error: The program size (${size.flash} bytes) is greater than maximum allowed (${size.flashMax} bytes)`);
    return { errors, warnings };
}
