import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ElfFile } from "./elf";
import { ESP_IMAGE_PRESETS, elfToEspImage, type ElfToImageOptions } from "./esp-image";

const FIX = join(import.meta.dir, "../test-fixtures");

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

/**
 * Fixtures: firmware.elf is pioarduino 55.03.39 (Arduino-ESP32 3.3.9) building sketches/blink,
 * debug-stripped; firmware.bin is esptool 5.3.0's elf2image of exactly that ELF with the preset's
 * flags. bootloader/<chip>: the bootloader ELF pioarduino flashes for that board (debug-stripped)
 * and esptool 5.3.0's image of it (identical to PlatformIO's bootloader.bin).
 */
const APP_FIXTURES = ["esp32dev", "esp32-s3", "esp32-c3", "esp32-c6"] as const;

describe("elfToEspImage matches esptool elf2image byte for byte", () => {
    for (const board of APP_FIXTURES) {
        test(`app ${board}`, async () => {
            const dir = join(FIX, board, "blink");
            const out = await elfToEspImage(read(join(dir, "firmware.elf")), ESP_IMAGE_PRESETS[board]);
            expectSameBytes(out, read(join(dir, "firmware.bin")));
        });
    }

    const bootloaders: Array<[string, ElfToImageOptions]> = [
        ["esp32", { chip: "esp32", flashMode: "dio", flashFreq: "40m", flashSize: "4MB" }],
        ["esp32s3", { chip: "esp32s3", flashMode: "dio", flashFreq: "80m", flashSize: "8MB" }],
        ["esp32c3", { chip: "esp32c3", flashMode: "dio", flashFreq: "80m", flashSize: "4MB" }],
        ["esp32c6", { chip: "esp32c6", flashMode: "dio", flashFreq: "80m", flashSize: "8MB" }],
    ];
    for (const [name, opts] of bootloaders) {
        test(`bootloader ${name}`, async () => {
            const dir = join(FIX, "bootloader", name);
            const out = await elfToEspImage(read(join(dir, "bootloader.elf")), opts);
            expectSameBytes(out, read(join(dir, "bootloader.bin")));
        });
    }
});

describe("elfToEspImage", () => {
    test("header fields", async () => {
        const out = await elfToEspImage(read(join(FIX, "esp32-s3/blink/firmware.elf")), ESP_IMAGE_PRESETS["esp32-s3"]);
        expect(out[0]).toBe(0xe9);
        expect(out[2]).toBe(2); // dio
        expect(out[3]).toBe(0x3f); // 8MB | 80m
        expect(out[12]! | (out[13]! << 8)).toBe(9); // chip id ESP32-S3
        expect(out[17]! | (out[18]! << 8)).toBe(65535); // max_rev_full default
        expect(out[23]).toBe(1); // append_digest
        // The appended digest covers everything before it.
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", out.slice(0, out.length - 32)));
        expect(out.subarray(out.length - 32)).toEqual(digest);
    });

    test("ESP32-C6 header: chip id 13, 80m encoded as 0", async () => {
        const out = await elfToEspImage(read(join(FIX, "esp32-c6/blink/firmware.elf")), ESP_IMAGE_PRESETS["esp32-c6"]);
        expect(out[3]).toBe(0x30); // 8MB | 80m (0x0 on the C6)
        expect(out[12]! | (out[13]! << 8)).toBe(13);
    });

    /** The C6 ELF with the app descriptor's mmu_page_size byte (log2, offset 180) replaced. */
    function c6WithMmuPageSize(log2: number): Uint8Array {
        const elf = read(join(FIX, "esp32-c6/blink/firmware.elf"));
        const appdesc = new ElfFile(elf).sections.find((s) => s.name === ".flash.appdesc")!;
        expect(elf[appdesc.offset + 180]).toBe(16); // ESP-IDF 5.5 writes 64 KB
        elf[appdesc.offset + 180] = log2;
        return elf;
    }

    // SHA-256 of esptool 5.3.0's image of exactly these patched ELFs (fixture ELF + one byte), so
    // the MMU page size paths are checked byte for byte without extra fixtures.
    const sha256Hex = async (b: Uint8Array) =>
        Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(b))).toString("hex");

    test("ESP32-C6 without mmu_page_size guesses 64 KB from the app descriptor address", async () => {
        const out = await elfToEspImage(c6WithMmuPageSize(0), ESP_IMAGE_PRESETS["esp32-c6"]);
        expect(await sha256Hex(out)).toBe("fc133b2890b89a17ee113e772a56decee2db0bd23b5b56f62e8380e4ec59e9ca");
    });

    test("ESP32-C6 honours an 8 KB mmu_page_size and rejects invalid ones", async () => {
        const out = await elfToEspImage(c6WithMmuPageSize(13), ESP_IMAGE_PRESETS["esp32-c6"]);
        expect(await sha256Hex(out)).toBe("43f3062efeaf17514a9e160349844d37579d8dd6af59f35abf623a1cae0f43e9");
        await expect(elfToEspImage(c6WithMmuPageSize(17), ESP_IMAGE_PRESETS["esp32-c6"])).rejects.toThrow(
            /131072 bytes is not a valid ESP32-C6 page size/,
        );
        await expect(elfToEspImage(c6WithMmuPageSize(9), ESP_IMAGE_PRESETS["esp32-c6"])).rejects.toThrow(
            /^0 bytes is not a valid ESP32-C6 page size/,
        );
    });

    test("rejects non-ESP ELF", async () => {
        const avr = join(FIX, "uno/blink/firmware.elf");
        if (!existsSync(avr)) return;
        await expect(elfToEspImage(read(avr), ESP_IMAGE_PRESETS.esp32dev)).rejects.toThrow(/Xtensa or an RISCV/);
    });

    test("rejects unknown flash size", async () => {
        await expect(
            elfToEspImage(read(join(FIX, "esp32dev/blink/firmware.elf")), { ...ESP_IMAGE_PRESETS.esp32dev, flashSize: "3MB" }),
        ).rejects.toThrow(/Flash size '3MB'/);
    });
});

// Optional: unstripped native PlatformIO builds of test-fixtures/sketches/blink, one per board
// (ARDUINO_WASM_NATIVE_BUILDS=<project>/.pio/build; <dir>/<board>/firmware.{elf,bin}), and an
// esptool.py image of the esp32s3 bootloader at $ARDUINO_WASM_NATIVE_BUILDS/../../../esp/bootloader-s3.bin.
const NATIVE = process.env.ARDUINO_WASM_NATIVE_BUILDS;
const PIO_PACKAGES = process.env.PLATFORMIO_PACKAGES_DIR ?? join(process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio"), "packages");
describe("elfToEspImage vs native PlatformIO builds (optional)", () => {
    for (const board of Object.keys(ESP_IMAGE_PRESETS) as Array<keyof typeof ESP_IMAGE_PRESETS>) {
        const dir = join(NATIVE ?? "", board);
        test.skipIf(!NATIVE || !existsSync(join(dir, "firmware.elf")))(`unstripped ${board}`, async () => {
            const out = await elfToEspImage(read(join(dir, "firmware.elf")), ESP_IMAGE_PRESETS[board]);
            expectSameBytes(out, read(join(dir, "firmware.bin")));
        });
    }
    const s3Boot = join(PIO_PACKAGES, "framework-arduinoespressif32-libs/esp32s3/bin/bootloader_qio_80m.elf");
    const s3BootRef = join(NATIVE ?? "", "../../../esp/bootloader-s3.bin");
    test.skipIf(!NATIVE || !existsSync(s3Boot) || !existsSync(s3BootRef))("bootloader esp32s3", async () => {
        const out = await elfToEspImage(read(s3Boot), { chip: "esp32s3", flashMode: "dio", flashFreq: "80m", flashSize: "8MB" });
        expectSameBytes(out, read(s3BootRef));
    });
});
