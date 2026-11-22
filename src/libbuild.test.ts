import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readArchive } from "./ar";
import { PackStore } from "./cache";
import { applyFlags, HeaderIndexResolver, libraryArchive, libTemplate, missingIncludes } from "./libbuild";

describe("library compile lines", () => {
    const tmpl = ["-quiet", "-I", "src", "${LIBINC}", "-I", "/core", "-D", "ARDUINO=10808", "${SRC}", "-Os", "-o", "${ASM}"];
    test("the project's -I src is dropped", () => {
        expect(libTemplate(tmpl)).toEqual(["-quiet", "${LIBINC}", "-I", "/core", "-D", "ARDUINO=10808", "${SRC}", "-Os", "-o", "${ASM}"]);
    });
    test("defines after the board's, other flags before -o, unflags removed", () => {
        expect(applyFlags(tmpl, ["-DFOO=1", "-U", "BAR", "-Wno-unused", "-O2"], ["-Os"])).toEqual(["-quiet", "-I", "src", "${LIBINC}", "-I", "/core", "-D", "ARDUINO=10808", "-D", "FOO=1", "-U", "BAR", "${SRC}", "-Wno-unused", "-O2", "-o", "${ASM}"]);
    });
});

describe("missing framework headers (headerIndex retry)", () => {
    test("parses the compiler's message with the include's quoting", () => {
        const out = `src/main.ino.cpp:3:10: fatal error: esp_foo.h: No such file or directory\n    3 | #include <esp_foo.h>\n      |          ^~~~~~~~~~~\ncompilation terminated.`;
        expect(missingIncludes(out, "/work/project")).toEqual([{ header: "esp_foo.h", file: "/work/project/src/main.ino.cpp", line: 3, quoted: false }]);
        const q = `/opt/x/a.h:1:10: fatal error: sub/b.h: No such file or directory\n    1 | #include "sub/b.h"`;
        expect(missingIncludes(q, "/work/project")[0]!.quoted).toBe(true);
    });
    test("finds the header in the index's directory order, next to the includer for quoted includes", async () => {
        const enc = new TextEncoder();
        const files: Record<string, Uint8Array> = {};
        const idx = { dirs: ["/fw/a", "/fw/b"], files: [[1, "x.h", "b".repeat(32), 2], [0, "x.h", "a".repeat(32), 2], [1, "sub/y.h", "c".repeat(32), 2]] };
        files["files/" + "a".repeat(32) + ".h"] = enc.encode("A\n");
        files["files/" + "b".repeat(32) + ".h"] = enc.encode("B\n");
        files["files/" + "c".repeat(32) + ".h"] = enc.encode("C\n");
        files["idx.json"] = enc.encode(JSON.stringify(idx));
        const store = new PackStore("http://p/", { cacheStorage: false, fetch: async (u) => new Response(files[new URL(u).pathname.slice(1)]! as BodyInit) });
        const r = new HeaderIndexResolver(store, { file: "idx.json", size: 0, sha256: "i" });
        expect((await r.find("x.h", null, false))!.path).toBe("/fw/a/x.h");
        expect((await r.find("y.h", "/fw/b/sub/z.h", true))!.path).toBe("/fw/b/sub/y.h");
        expect(await r.find("y.h", "/fw/b/sub/z.h", false)).toBeNull();
        expect(await r.find("nope.h", null, false)).toBeNull();
    });
});

describe("library archives", () => {
    // pio's own `ar rc` output (spike: lib_deps BME280): identical members, order and index; ar rc
    // (no D) stamps the time and mode into the headers, the only bytes that may differ
    const normalize = (a: Uint8Array) => {
        const b = a.slice();
        for (let o = 8; o + 60 <= b.length; ) {
            const size = Number(new TextDecoder().decode(b.subarray(o + 48, o + 58)).trim());
            b.fill(0x20, o + 16, o + 28);
            b.fill(0x20, o + 40, o + 48);
            o += 60 + size + (size & 1);
        }
        return b;
    };
    for (const f of ["pio-uno-BusIO.a", "pio-nodemcu-BME280.a"]) {
        test(`${f}: writer == pio's ar rc (up to dates and modes)`, () => {
            const native = new Uint8Array(readFileSync(join(import.meta.dir, "../test-fixtures/ar-pio", f)));
            const members = readArchive(native).members.map((m) => ({ path: `x/${m.name}`, data: m.data }));
            expect(normalize(libraryArchive(members))).toEqual(normalize(native));
        });
    }
});
