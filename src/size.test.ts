import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { elfSizes, formatSizeReport, sizeProblems, sizeReport } from "./size";
import type { KnownBoard as Board } from "./types";

const FIX = join(import.meta.dir, "../test-fixtures");

/** pio-size.txt: the RAM/Flash lines of `pio run` for exactly that build. */
const cases: Array<[Board, string]> = [
    ["uno", "uno/blink"],
    ["uno", "uno/avr-eeprom"],
    ["esp32dev", "esp32dev/blink"],
    ["esp32-s3", "esp32-s3/blink"],
    ["esp32-c3", "esp32-c3/blink"],
];

describe("size report = PlatformIO checkprogsize", () => {
    for (const [board, dir] of cases) {
        test(`${board} ${dir}`, () => {
            const elf = new Uint8Array(readFileSync(join(FIX, dir, "firmware.elf")));
            const size = sizeReport(elf, board);
            expect(formatSizeReport(size)).toBe(readFileSync(join(FIX, dir, "pio-size.txt"), "utf8").trimEnd());
        });
    }

    test("sums the same sections as PlatformIO's regex over `size -A -d`", () => {
        // Python: sum(int(m.group(1))) for stripped lines matching SIZEPROGREGEXP / SIZEDATAREGEXP
        const prog = /^(?:\.iram0\.text|\.iram0\.vectors|\.dram0\.data|\.flash\.text|\.flash\.rodata|)\s+([0-9]+).*/;
        const data = /^(?:\.dram0\.data|\.dram0\.bss|\.noinit)\s+([0-9]+).*/;
        for (const dir of ["esp32dev/blink", "esp32-s3/blink", "esp32-c3/blink"]) {
            const lines = readFileSync(join(FIX, dir, "size-A.txt"), "utf8").split("\n").map((l) => l.trim());
            const sum = (re: RegExp) => lines.reduce((a, l) => a + Number(re.exec(l)?.[1] ?? 0), 0);
            const elf = new Uint8Array(readFileSync(join(FIX, dir, "firmware.elf")));
            expect(elfSizes(elf, "esp32")).toEqual({ flash: sum(prog), ram: sum(data) });
        }
    });

    test("format edge cases and limits", () => {
        expect(formatSizeReport({ flash: 32256, flashMax: 32256, ram: 0, ramMax: 2048 })).toBe(
            "RAM:   [          ]   0.0% (used 0 bytes from 2048 bytes)\nFlash: [==========]  100.0% (used 32256 bytes from 32256 bytes)",
        );
        expect(sizeProblems({ flash: 40000, flashMax: 32256, ram: 3000, ramMax: 2048 })).toEqual({
            errors: ["Error: The program size (40000 bytes) is greater than maximum allowed (32256 bytes)"],
            warnings: ["Warning! The data size (3000 bytes) is greater than maximum allowed (2048 bytes)"],
        });
    });
});
