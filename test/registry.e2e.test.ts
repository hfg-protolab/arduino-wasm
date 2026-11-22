/**
 * End to end with PlatformIO registry libraries (needs the network): a sketch with
 * `lib_deps = adafruit/Adafruit BME280 Library@2.3.0` in platformio.ini, compiled with
 * compileFirmware (registry directly, no host route), against
 *  1. a native ld over the same files (byte-identical ELF up to ld's own file symbols), and
 *  2. `pio run` with the same lib_deps line (same checks as test/e2e.test.ts),
 * plus the second, cached compile, and the "header missing" suggestions.
 *
 *   PACK=.build/packs/<version> bun test test/registry.e2e.test.ts      (in the pio-image)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, REPO } from "../pack/common.ts";
import { compileFirmware } from "../src/compile";
import { ElfFile } from "../src/elf";
import { elfToEspImage } from "../src/esp-image";
import type { BoardManifest } from "../src/manifest";
import { classifyImageDiff } from "./corpus/run";
import { compareWithNative, diffCount, nativeLink } from "./native-link";
import { diskFetch, PACK_BASE } from "./node-fetch";
import { referenceBuild, sketchFiles } from "./reference-build";

const cfg = loadConfig();
const PACK = process.env.PACK ?? join(REPO, ".build/packs", cfg.packVersion);
const BOARDS = (process.env.BOARDS ?? "uno,esp32dev,esp32-c3,nodemcu").split(",");
const LIB = "adafruit/Adafruit BME280 Library@2.3.0";
const INI = `[env]\nlib_deps =\n    ${LIB}\n`;
const NATIVE = process.env.NATIVE !== "0";

const manifestOf = (board: string): BoardManifest | null => {
    const p = join(PACK, "boards", `${board}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

describe.each(BOARDS)("lib_deps BME280 on %s", (board) => {
    const m = manifestOf(board);
    const t = m?.registry ? test : test.skip;
    t(
        "compiles with the registry library, identical to the native link and to pio run",
        async () => {
            const files = [...sketchFiles("bme280"), { path: "platformio.ini", content: INI }];
            const t0 = performance.now();
            const r = await compileFirmware({ board, files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), keepIntermediates: true, cacheStorage: false });
            const first = performance.now() - t0;
            if (!r.ok) console.log(r.errors, r.problem, r.log.slice(-3000));
            expect(r.ok).toBe(true);
            expect(r.stats!.registry!.libraries).toEqual(["Adafruit BME280 Library@2.3.0"]);
            const t1 = performance.now();
            const again = await compileFirmware({ board, files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
            console.log(`${board}: first ${Math.round(first)} ms, cached ${Math.round(performance.now() - t1)} ms (${again.stats!.registry!.cached} library TUs from the cache)`);
            expect(again.stats!.registry!.compiled).toBe(0);
            if (!NATIVE) return;

            const elf = r.intermediates!.get(`${m!.fs.cwd}/${m!.fs.buildDir}/firmware.elf`)!;
            const native = nativeLink(PACK, m!, r.intermediates!, r.link!.objects, r.link!.archives);
            expect(compareWithNative(m!, elf, native)).toBeNull();

            const ref = referenceBuild("bme280", board, false, [`lib_deps = ${LIB}`]);
            if (m!.output.kind === "hex") {
                expect(new TextDecoder().decode(r.files[0]!.data)).toBe(readFileSync(join(ref, "firmware.hex"), "utf8"));
            } else if (m!.output.kind === "esp8266-image") {
                expect(diffCount(r.files[0]!.data, new Uint8Array(readFileSync(join(ref, "firmware.bin"))))).toBe(0);
            } else {
                const app = r.files.find((f) => f.name === "firmware.bin")!.data;
                const nativeApp = await elfToEspImage(native.elf, m!.output.image);
                expect(diffCount(app, nativeApp, (i) => (i >= 0xb0 && i < 0xd0) || i >= nativeApp.length - 33)).toBe(0);
                const c = classifyImageDiff(app, new Uint8Array(readFileSync(join(ref, "firmware.bin"))), new ElfFile(elf));
                expect([...c.other]).toEqual([]);
            }
        },
        900_000,
    );
});

describe("framework headers outside the bundle", () => {
    const t = manifestOf("esp32dev")?.headerIndex ? test : test.skip;
    t("are fetched from the headerIndex and the TU compiled again", async () => {
        const files = [{ path: "Lcd.ino", content: "#include <esp_lcd_panel_io.h>\n#include <esp_lcd_panel_ops.h>\nvoid setup() { esp_lcd_panel_io_handle_t io = nullptr; (void)io; }\nvoid loop() {}\n" }];
        const r = await compileFirmware({ board: "esp32dev", files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
        if (!r.ok) console.log(r.errors);
        expect(r.ok).toBe(true);
    }, 300_000);
});

describe("missing headers", () => {
    const t = manifestOf("uno")?.registry ? test : test.skip;
    t("a header no library provides comes back with registry suggestions", async () => {
        const files = [{ path: "Mqtt.ino", content: "#include <PubSubClient.h>\nvoid setup() {}\nvoid loop() {}\n" }];
        const r = await compileFirmware({ board: "uno", files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
        expect(r.ok).toBe(false);
        expect(r.missingHeaders?.[0]).toMatchObject({ header: "PubSubClient.h", file: "Mqtt.ino", line: 1 });
        expect(r.missingHeaders![0]!.suggestions.length).toBeGreaterThan(0);
        expect(r.missingHeaders![0]!.suggestions.map((s) => `${s.owner}/${s.name}`)).toContain("knolleary/PubSubClient");
    });
    t("an unknown library is a structured problem", async () => {
        const files = [...sketchFiles("blink"), { path: "platformio.ini", content: "[env:uno]\nlib_deps = nobody-xyz/No Such Library 42\n" }];
        const r = await compileFirmware({ board: "uno", files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
        expect(r.ok).toBe(false);
        expect(r.problem).toEqual({ kind: "libNotFound", spec: "nobody-xyz/No Such Library 42" });
        expect(r.errors[0]!.message).toBe('library "nobody-xyz/No Such Library 42" not found');
    });
});
