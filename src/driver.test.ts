import { describe, expect, test } from "bun:test";
import { parseDiagnostics } from "./diagnostics";
import { expandArgs } from "./driver";

describe("expandArgs", () => {
    test("substitutes scalars inside arguments and expands list placeholders", () => {
        const t = ["-quiet", "-I", "src", "${LIBINC}", "-I", "/core", "${SRC}", "-dumpbase", "${DUMPBASE}", "-auxbase-strip", "${OBJ}", "--x=${OBJ}.d", "-o", "${ASM}"];
        const out = expandArgs(t, { SRC: "src/a b.ino.cpp", DUMPBASE: "a b.ino.cpp", OBJ: ".pio/build/uno/src/a b.ino.cpp.o", ASM: "/tmp/tu0.s" }, { LIBINC: ["-I", "/opt/pio-libs/all/Lib A"] });
        expect(out).toEqual(["-quiet", "-I", "src", "-I", "/opt/pio-libs/all/Lib A", "-I", "/core", "src/a b.ino.cpp", "-dumpbase", "a b.ino.cpp", "-auxbase-strip", ".pio/build/uno/src/a b.ino.cpp.o", "--x=.pio/build/uno/src/a b.ino.cpp.o.d", "-o", "/tmp/tu0.s"]);
        expect(expandArgs(["${LIBINC}", "x"], {}, { LIBINC: [] })).toEqual(["x"]);
    });
    test("throws on an unknown placeholder", () => {
        expect(() => expandArgs(["${NOPE}"], {})).toThrow(/NOPE/);
    });
});

describe("parseDiagnostics", () => {
    const ctx = {
        cwd: "/work/project",
        paths: new Map([
            ["src/Blink.ino", "Blink.ino"],
            ["src/util/helper.cpp", "util/helper.cpp"],
        ]),
        mainIno: "Blink.ino",
        strip: [/^\/opt\/pio\/packages\//, /^\/opt\/pio-libs\/[^/]+\//],
    };
    test("maps the sketch's paths and keeps only its own warnings", () => {
        const log = [
            "/work/project/src/Blink.ino: In function 'void loop()':",
            "/work/project/src/Blink.ino:5:3: error: 'foo' was not declared in this scope",
            "src/util/helper.cpp:2:1: warning: unused variable 'x' [-Wunused-variable]",
            "/opt/pio-libs/all/Adafruit SSD1306/Adafruit_SSD1306.cpp:10:2: warning: something",
            "/opt/pio/packages/framework-arduino-avr/cores/arduino/Arduino.h:1:1: error: boom",
            "src/main.ino.cpp:12:1: error: generated",
        ].join("\n");
        const d = parseDiagnostics(log, ctx);
        expect(d.errors).toEqual([
            { file: "Blink.ino", line: 5, column: 3, message: "'foo' was not declared in this scope" },
            { file: "framework-arduino-avr/cores/arduino/Arduino.h", line: 1, column: 1, message: "boom" },
            { file: "Blink.ino", line: 12, column: 1, message: "generated" },
        ]);
        expect(d.warnings).toEqual([{ file: "util/helper.cpp", line: 2, column: 1, message: "unused variable 'x' [-Wunused-variable]" }]);
    });
    test("linker errors", () => {
        const log = [
            "/opt/pio/packages/toolchain-atmelavr/avr/bin/ld: .pio/build/uno/src/Blink.ino.cpp.o: in function `loop':",
            "Blink.ino.cpp:(.text.loop+0x2): undefined reference to `missing()'",
            "/opt/pio/packages/toolchain-xtensa-esp32/bin/ld: region `iram0_0_seg' overflowed by 12 bytes",
        ].join("\n");
        expect(parseDiagnostics(log, ctx).errors.map((e) => e.message)).toEqual(["undefined reference to `missing()'", "region `iram0_0_seg' overflowed by 12 bytes"]);
    });
});
