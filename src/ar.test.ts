import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ArError, archiveSymbols, readArchive, writeArchive, type ArMember } from "./ar";

const FIX = join(import.meta.dir, "../test-fixtures/ar");

/**
 * Fixtures in test-fixtures/ar, all made by the native binutils with deterministic headers:
 * - avr-core.a: Arduino core objects built without -flto + avr-libc errno.o/iob.o (COMMON symbols); `avr-ar rcsD`
 * - avr-lto.a: slim GCC-7 LTO core objects; `avr-gcc-ar rcsD` (index from the LTO plugin)
 * - avr-lto-noplugin.a: the same objects with plain `avr-ar rcsD` (index = placeholder ELF symbols only)
 * - idf-efuse.a: ESP-IDF libefuse.a members (--strip-debug), long and duplicate names; `xtensa-esp32-elf-ar qcD` + `ranlib -D`
 * - riscv-syn.a: hand-written asm with GLOBAL, WEAK, GNU_UNIQUE, COMMON, ABS, undefined and local symbols; `riscv32-esp-elf-ar qcD` + `ranlib -D`
 * - riscv-mixed.a: an object without globals, a text file and an object; same tools
 */
const read = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));

describe("writeArchive reproduces native `ar rcsD` byte for byte", () => {
    for (const name of readdirSync(FIX).filter((f) => f.endsWith(".a") && f !== "avr-lto-noplugin.a")) {
        test(name, () => {
            const native = read(name);
            const { members } = readArchive(native);
            expect(writeArchive(members)).toEqual(native);
        });
    }
});

describe("symbol index", () => {
    test("binding rules: GLOBAL, WEAK, GNU_UNIQUE, COMMON, ABS in; undefined and local out; symtab order", () => {
        const { members, index } = readArchive(read("riscv-syn.a"));
        expect(members.map((m) => m.name)).toEqual(["syn.o", "syn2.o"]);
        expect(index).toEqual([
            ...["g_func", "w_func", "u_obj", "c_common", "abs_sym", "g_late", "g_second"].map((symbol) => ({ symbol, member: 0 })),
            { symbol: "only_data", member: 1 },
        ]);
    });

    test("objects without globals and non-ELF members get no entries, but the index is still written", () => {
        const { members, index } = readArchive(read("riscv-mixed.a"));
        expect(members.map((m) => m.name)).toEqual(["nog.o", "note.txt", "syn2.o"]);
        expect(index).toEqual([{ symbol: "only_data", member: 2 }]);
        expect(archiveSymbols(members[0]!.data)).toEqual([]);
        expect(archiveSymbols(members[1]!.data)).toBeNull();
    });

    test("no ELF member → no index (like ar)", () => {
        const out = writeArchive([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
        expect(readArchive(out).index).toBeUndefined();
        expect(new TextDecoder().decode(out.subarray(8, 10))).toBe("a.");
    });

    test("LTO objects: index from the .gnu.lto_.symtab section (DEF, WEAKDEF, COMMON), like gcc-ar", () => {
        const { members, index } = readArchive(read("avr-lto.a"));
        const hooks = members.findIndex((m) => m.name === "hooks.c.o");
        expect(index!.filter((e) => e.member === hooks).map((e) => e.symbol)).toEqual(["yield"]); // weak def
        expect(index!.some((e) => e.symbol.startsWith("__gnu_lto"))).toBe(false);
    });

    test("callback symbols: reproduces plain avr-ar (no LTO plugin) on the same LTO objects", () => {
        const native = read("avr-lto-noplugin.a");
        const { members, index } = readArchive(native);
        const bySym = new Map<ArMember, string[]>();
        index!.forEach((e) => {
            const m = members[e.member]!;
            bySym.set(m, [...(bySym.get(m) ?? []), e.symbol]);
        });
        expect(writeArchive(members, { symbols: (m) => bySym.get(m) ?? [] })).toEqual(native);
    });

    test('symbols: "none" writes no index; offsets stay consistent', () => {
        const { members } = readArchive(read("idf-efuse.a"));
        const out = writeArchive(members, { symbols: "none" });
        const back = readArchive(out);
        expect(back.index).toBeUndefined();
        expect(back.members.map((m) => m.name)).toEqual(members.map((m) => m.name));
        back.members.forEach((m, i) => expect(m.data).toEqual(members[i]!.data));
    });
});

describe("names", () => {
    test("long names via //, duplicates kept in order", () => {
        const { members } = readArchive(read("idf-efuse.a"));
        expect(members.map((m) => m.name)).toEqual([
            "esp_efuse_table.c.obj",
            "esp_efuse_fields.c.obj",
            "esp_efuse_fields.c.obj",
            "esp_efuse_utility.c.obj",
            "esp_efuse_api_key_esp32.c.obj",
            "esp_efuse_utility.c.obj",
        ]);
        expect(members[1]!.data).not.toEqual(members[2]!.data);
    });

    test("15-byte names stay short, 16 go to //, odd sizes padded with \\n", () => {
        const out = writeArchive(
            [
                { name: "a".repeat(15), data: new Uint8Array([1]) },
                { name: "b".repeat(16), data: new Uint8Array([2, 3]) },
            ],
            { symbols: "none" },
        );
        const text = new TextDecoder("latin1").decode(out);
        // "//" header: name and size only (16 + 32 blanks + size 10 + "`\n").
        expect(text.startsWith("!<arch>\n" + "//".padEnd(48) + "18".padEnd(10) + "`\n" + "b".repeat(16) + "/\n")).toBe(true);
        expect(text).toContain("a".repeat(15) + "/0           0     0     644     1         `\n\x01\n");
        expect(text).toContain("/0              0           0     0     644     2         `\n\x02\x03");
        expect(readArchive(out).members.map((m) => m.name)).toEqual(["a".repeat(15), "b".repeat(16)]);
    });

    test("rejects names with /", () => {
        expect(() => writeArchive([{ name: "x/y.o", data: new Uint8Array() }])).toThrow(ArError);
    });

    test("readArchive rejects non-archives", () => {
        expect(() => readArchive(new TextEncoder().encode("hello world"))).toThrow(ArError);
    });
});

// With the PlatformIO toolchains installed: compare against the shipped IDF archives and native ar/nm.
const PIO = process.env.PLATFORMIO_PACKAGES_DIR ?? join(process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio"), "packages");
const XT = join(PIO, "toolchain-xtensa-esp32/bin/xtensa-esp32-elf-");
const IDF = join(PIO, "framework-arduinoespressif32/tools/sdk/esp32/lib");
const haveToolchain = existsSync(XT + "ar") && existsSync(join(IDF, "liblwip.a"));

describe.skipIf(!haveToolchain)("against the xtensa toolchain", () => {
    const run = (tool: string, args: string[], cwd?: string) => {
        const r = spawnSync(XT + tool, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
        if (r.status !== 0) throw new Error(`${tool} ${args.join(" ")}: ${r.stderr}`);
        return r.stdout;
    };

    for (const lib of ["libfreertos.a", "liblwip.a", "libhal.a", "libdriver.a"]) {
        test(`${lib}: rewrite == native ar qcD + ranlib -D, same ar t / nm -s`, () => {
            const src = new Uint8Array(readFileSync(join(IDF, lib)));
            const { members } = readArchive(src);
            const dir = mkdtempSync(join(tmpdir(), "ar-test-"));
            try {
                const seen = new Map<string, number>();
                const paths = members.map((m) => {
                    const n = seen.get(m.name) ?? 0;
                    seen.set(m.name, n + 1);
                    mkdirSync(join(dir, String(n)), { recursive: true });
                    const p = join(dir, String(n), m.name);
                    writeFileSync(p, m.data);
                    return p;
                });
                const nat = join(dir, "native.a");
                const mine = join(dir, "mine.a");
                run("ar", ["qcD", nat, ...paths]);
                run("ranlib", ["-D", nat]);
                writeFileSync(mine, writeArchive(members));
                expect(new Uint8Array(readFileSync(mine))).toEqual(new Uint8Array(readFileSync(nat)));
                expect(run("ar", ["t", mine])).toBe(run("ar", ["t", nat]));
                expect(run("nm", ["-s", mine]).replaceAll(mine, "X")).toBe(run("nm", ["-s", nat]).replaceAll(nat, "X"));
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});
