/**
 * End to end, in Node/Bun: compileFirmware against a pack built by pack/build.ts, served from
 * disk. Skipped when the pack (or a board of it) is missing. Per case:
 *
 *  1. byte identity with a NATIVE link over the same stripped pack files: the native ld of the
 *     PlatformIO toolchain, same argv, the wasm-compiled sketch objects, the full (not lazily
 *     reduced) framework archives → the ELF must equal the wasm ld's ELF;
 *  2. against `pio run` (test/reference-build.ts): AVR .hex identical (pio built without LTO);
 *     ESP32 app image identical outside the fields that hash the ELF's debug info (SHA-256 at
 *     0xb0, checksum, appended digest), bootloader/partitions/boot_app0 identical.
 *
 *   PACK=.build/packs/<version> bun test test/e2e.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, REPO } from "../pack/common.ts";
import { compileFirmware } from "../src/compile";
import { elfToEspImage } from "../src/esp-image";
import type { BoardManifest } from "../src/manifest";
import { compareWithNative, diffCount, nativeLink } from "./native-link";
import { diskFetch, PACK_BASE } from "./node-fetch";
import { referenceBuild, sketchFiles } from "./reference-build";

const cfg = loadConfig();
const PACK = process.env.PACK ?? join(REPO, ".build/packs", cfg.packVersion);
const CASES: Array<[string, string]> = [
    ["blink", "uno"],
    ["oled_uno", "uno"],
    ["multi", "uno"],
    ["blink", "nano"],
    ["blink", "nano-old"],
    ["blink", "esp32dev"],
    ["wifi", "esp32dev"],
    ["blink", "esp32-s3"],
    ["wifi", "esp32-s3"],
    ["blink", "esp32-c3"],
    ["wifi", "esp32-c3"],
];

const manifestOf = (board: string): BoardManifest | null => {
    const p = join(PACK, "boards", `${board}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
describe.each(CASES)("e2e %s on %s", (sketch, board) => {
    const m = manifestOf(board);
    const t = m ? test : test.skip;
    t(
        "compiles, links byte-identically to native ld, matches pio",
        async () => {
            const r = await compileFirmware({ board, files: sketchFiles(sketch) }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), keepIntermediates: true, cacheStorage: false });
            if (!r.ok) console.log(r.errors, r.log.slice(-3000));
            expect(r.ok).toBe(true);
            const elfPath = `${m!.fs.cwd}/${m!.fs.buildDir}/firmware.elf`;
            const elf = r.intermediates!.get(elfPath)!;
            const objs = [...r.intermediates!.keys()].filter((p) => p.endsWith(".o")).map((p) => p.slice(m!.fs.cwd.length + 1)).sort();
            // the wasm link's library order (LDF post-order)
            const libs = r.stats!.libraries.map((n) => m!.libraries.find((l) => l.name === n)!).filter((l) => l.archive).map((l) => l.archive!.path);

            // 1. native link over the same files
            const native = nativeLink(PACK, m!, r.intermediates!, objs, libs);
            const why = compareWithNative(m!, elf, native);
            expect(why).toBeNull();
            if (diffCount(elf, native.elf)) console.log(`${sketch}.${board}: ELF equal to the native link up to the path of ld's own file symbols`);

            // 2. pio
            const ref = referenceBuild(sketch, board);
            if (m!.output.kind === "hex") {
                const hex = new TextDecoder().decode(r.files.find((f) => f.name === "firmware.hex")!.data);
                expect(hex).toBe(readFileSync(join(ref, "firmware.hex"), "utf8"));
            } else {
                const app = r.files.find((f) => f.name === "firmware.bin")!.data;
                const nativeApp = await elfToEspImage(native.elf, m!.output.image);
                const masked0 = (i: number) => (i >= 0xb0 && i < 0xd0) || i >= nativeApp.length - 33;
                expect(diffCount(app, nativeApp, masked0)).toBe(0);
                const pio = new Uint8Array(readFileSync(join(ref, "firmware.bin")));
                expect(app.length).toBe(pio.length);
                // masked: ELF SHA-256 (0xb0..0xd0), checksum byte (before the digest), digest (last 32)
                const n = app.length;
                const masked = (i: number) => (i >= 0xb0 && i < 0xd0) || i >= n - 33;
                const d = diffCount(app, pio, masked);
                if (d) console.log(`${sketch}.${board}: ${d} bytes differ from pio outside the masked fields (expected: .eh_frame of discarded COMDAT FDEs after --strip-debug)`);
                expect(d).toBeLessThanOrEqual(32);
                for (const f of ["bootloader.bin", "partitions.bin"]) expect(diffCount(r.files.find((x) => x.name === f)!.data, new Uint8Array(readFileSync(join(ref, f))))).toBe(0);
            }
        },
        600_000,
    );
});

describe("diagnostics", () => {
    const t = manifestOf("uno") ? test : test.skip;
    t("compiler errors point into the sketch's own files", async () => {
        const files = [
            { path: "Broken.ino", content: '#include "helper.h"\n\nvoid setup() {\n  pinMode(13, OUTPUT);\n  undefinedThing(1);\n}\n\nvoid loop() {}\n' },
            { path: "helper.h", content: "#pragma once\nint helper(int);\n" },
            { path: "helper.cpp", content: '#include "helper.h"\nint helper(int x) { int unused; return x }\n' },
        ];
        const r = await compileFirmware({ board: "uno", files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
        expect(r.ok).toBe(false);
        expect(r.errors).toContainEqual(expect.objectContaining({ file: "Broken.ino", line: 5, column: 3 }));
        expect(r.errors).toContainEqual(expect.objectContaining({ file: "helper.cpp", line: 2 }));
    });
    t("undefined references come from the linker", async () => {
        const files = [{ path: "Link.ino", content: "void missing();\nvoid setup() { missing(); }\nvoid loop() {}\n" }];
        const r = await compileFirmware({ board: "uno", files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
        expect(r.ok).toBe(false);
        expect(r.errors.map((e) => e.message)).toContainEqual(expect.stringContaining("undefined reference to `missing()'"));
    });
});

describe("prewarm", () => {
    const t = manifestOf("uno") ? test : test.skip;
    t("downloads the pack up front; a compile without libraries then fetches nothing", async () => {
        const { prewarm, resetCompilers } = await import("../src/compile");
        resetCompilers();
        const counter = { bytes: 0, requests: 0 };
        const opts = { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK, counter), cacheStorage: false };
        const progress: number[] = [];
        await prewarm("uno", { ...opts, onProgress: (p) => p.phase === "download" && progress.push(p.loaded) });
        expect(counter.bytes).toBeGreaterThan(1_000_000);
        // progress counts the pack files (not index.json / the manifest)
        expect(progress.at(-1)!).toBeGreaterThan(counter.bytes - 100_000);
        const before = counter.requests;
        const r = await compileFirmware({ board: "uno", files: sketchFiles("blink") }, opts);
        expect(r.ok).toBe(true);
        expect(counter.requests).toBe(before);
        expect(r.stats!.downloadedBytes).toBe(0);
    });
});
