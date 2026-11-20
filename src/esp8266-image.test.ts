import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc8266, elfToEsp8266Image, type Esp8266ImageOptions } from "./esp8266-image";

const FIX = join(import.meta.dir, "../test-fixtures");
const EBOOT = join(FIX, "esp8266/eboot.elf");
const NODEMCU: Esp8266ImageOptions = { flashMode: "dio", flashFreq: "40", flashSize: "4M" };

function read(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
}

/** Compare whole images; on mismatch report the first differing offset instead of a huge diff. */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
    let first = -1;
    const n = Math.min(actual.length, expected.length);
    for (let i = 0; i < n; i++) {
        if (actual[i] !== expected[i]) {
            first = i;
            break;
        }
    }
    expect({ length: actual.length, firstDiff: first }).toEqual({ length: expected.length, firstDiff: -1 });
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fixtures: PlatformIO espressif8266@4.2.1 builds (board nodemcuv2, Arduino core 3.1.2) — firmware.bin is
 * pio's own output of `elf2bin.py --eboot eboot.elf --app firmware.elf --flash_mode dio --flash_freq 40
 * --flash_size 4M`; test-fixtures/esp8266/eboot.elf is the core's bootloaders/eboot/eboot.elf.
 */
describe("elfToEsp8266Image matches elf2bin.py byte for byte", () => {
    for (const sketch of ["blink", "wifi"]) {
        test(`nodemcuv2 ${sketch}`, () => {
            const dir = join(FIX, "nodemcuv2", sketch);
            const out = elfToEsp8266Image(read(join(dir, "firmware.elf")), read(EBOOT), NODEMCU);
            expectSameBytes(out, read(join(dir, "firmware.bin")));
        });
    }
});

describe("elfToEsp8266Image", () => {
    // Expected bytes from running elf2bin.py itself with --flash_mode qio --flash_freq 80 --flash_size 1M
    // on the blink fixture; only the mode/freq-size bytes of both headers and the CRC differ from dio/40/4M.
    test("qio / 80 MHz / 1M headers and CRC", () => {
        const out = elfToEsp8266Image(read(join(FIX, "nodemcuv2/blink/firmware.elf")), read(EBOOT), {
            flashMode: "qio",
            flashFreq: "80",
            flashSize: "1M",
        });
        expect(out.length).toBe(270272);
        expect(hex(out.subarray(0, 8))).toBe("e902002f80f41040"); // eboot: 2 segments, qio, 80 MHz | 1M << 4
        expect(hex(out.subarray(4096, 4096 + 24))).toBe("e905002fc000104010102040a49a0300c01f040069db2c47");
        // Everything else is identical to the dio/40/4M reference.
        const ref = read(join(FIX, "nodemcuv2/blink/firmware.bin"));
        const differing = new Set([2, 3, 4096 + 2, 4096 + 3, 4116, 4117, 4118, 4119]);
        const diffs: number[] = [];
        for (let i = 0; i < out.length; i++) if (out[i] !== ref[i] && !differing.has(i)) diffs.push(i);
        expect(diffs).toEqual([]);
    });

    test("eboot is padded with 0xAA to 4 KB", () => {
        const out = elfToEsp8266Image(read(join(FIX, "nodemcuv2/blink/firmware.elf")), read(EBOOT), NODEMCU);
        expect(out[4095]).toBe(0xaa);
        expect(out[4096]).toBe(0xe9);
    });

    test("CRC words: length and crc8266 of the image with both words zeroed", () => {
        const out = elfToEsp8266Image(read(join(FIX, "nodemcuv2/wifi/firmware.elf")), read(EBOOT), NODEMCU);
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        expect(view.getUint32(0x1010, true)).toBe(out.length);
        const zeroed = out.slice();
        zeroed.fill(0, 0x1010, 0x1018);
        expect(view.getUint32(0x1014, true)).toBe(crc8266(zeroed));
    });

    test("crc8266 is CRC-32/MPEG-2", () => {
        expect(crc8266(new TextEncoder().encode("123456789"))).toBe(0x0376e6e7);
    });

    test("rejects unknown flash size", () => {
        expect(() =>
            elfToEsp8266Image(read(join(FIX, "nodemcuv2/blink/firmware.elf")), read(EBOOT), { ...NODEMCU, flashSize: "3M" }),
        ).toThrow(/flash size '3M'/);
    });

    test("rejects an app ELF without the expected sections", () => {
        // eboot.elf has no .irom0.text.
        expect(() => elfToEsp8266Image(read(EBOOT), read(EBOOT), NODEMCU)).toThrow(/\.irom0\.text/);
    });
});
