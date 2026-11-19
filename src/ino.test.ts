import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inoToCpp, preprocessFpreprocessed, PreprocessUnsupportedError } from "./ino";

const FIX = join(import.meta.dir, "../test-fixtures/ino");

/** Fixtures: test-fixtures/ino/<case>/{*.ino,*.pde,expected.cpp}, expected.cpp from PlatformIO's converter (scripts/pio-ino.py). */
describe("inoToCpp matches PlatformIO byte for byte", () => {
    for (const name of readdirSync(FIX)) {
        test(name, () => {
            const dir = join(FIX, name);
            const files = readdirSync(dir)
                .filter((f) => f !== "expected.cpp")
                .map((f) => ({ path: f, content: readFileSync(join(dir, f), "utf8") }));
            const r = inoToCpp(files, { tmpPath: "tmpfixture", srcDir: "/work/project/src" })!;
            expect(r.cpp).toBe(readFileSync(join(dir, "expected.cpp"), "utf8"));
        });
    }
});

describe("inoToCpp", () => {
    test("main sketch first, path and line mapping", () => {
        const r = inoToCpp([
            { path: "src/b_helper.ino", content: "int helper() { return 1; }\n" },
            { path: "main.cpp", content: "int x;" },
            { path: "lib/x.ino", content: "void ignored() {}" },
            { path: "a.ino", content: "\n\nvoid setup() { helper(); }\nvoid loop() {}\n" },
        ])!;
        expect(r.mainIno).toBe("/project/src/a.ino");
        expect(r.path).toBe("/project/src/a.ino.cpp");
        expect(r.inputs).toEqual(["/project/src/a.ino", "/project/src/b_helper.ino"]);
        // gcc reports into the .ino through the #line directive: setup is on line 3 of a.ino.
        expect(r.cpp).toContain('void setup();\nvoid loop();\nint helper();\n#line 3 "/project/src/a.ino"\nvoid setup() { helper(); }');
        expect(r.cpp).toContain('# 1 "/project/src/b_helper.ino"\nint helper() { return 1; }');
    });

    test("no .ino → null", () => {
        expect(inoToCpp([{ path: "main.cpp", content: "" }])).toBeNull();
    });

    test("custom preprocess hook gets the merged text", () => {
        let seen = "";
        inoToCpp([{ path: "s.ino", content: "void setup(){}\nvoid loop(){}" }], {
            tmpPath: "/t",
            preprocess: (c, p) => {
                seen = `${p}|${c}`;
                return c;
            },
        });
        expect(seen).toBe('/t|#include <Arduino.h>\n# 1 "/project/src/s.ino"\nvoid setup(){}\nvoid loop(){}');
    });
});

describe("preprocessFpreprocessed (gcc -fpreprocessed -dD -E)", () => {
    // Expected strings come from avr-g++ 7.3 / xtensa-esp32-elf-g++ 8.4 (identical output).
    test("whitespace, comments, columns, blank lines", () => {
        const src = 'int  a\t=  1 ;   \n\tint b = 2;\n  \t  int c = 3; // tail\nint d = /* multi\nline */ 5;\n/* lead\n x */   int e;\n';
        expect(preprocessFpreprocessed(src, "t.txt")).toBe('# 1 "t.txt"\nint a = 1 ;\n int b = 2;\n     int c = 3;\nint d =\n        5;\n\n        int e;\n');
    });

    test("7 blank lines are kept, 8 become a linemarker", () => {
        expect(preprocessFpreprocessed("int a;\n\n\n\n\n\n\n\nint b;\n", "b8")).toBe('# 1 "b8"\nint a;\n\n\n\n\n\n\n\nint b;\n');
        expect(preprocessFpreprocessed("int a;\n\n\n\n\n\n\n\n\nint b;\n", "b9")).toBe('# 1 "b9"\nint a;\n# 10 "b9"\nint b;\n');
    });

    test("#define normalisation", () => {
        const src = [
            "#define S1(x) # x",
            "#define S2(x) a #x",
            "#define S3(x) a# x",
            "#define S4 a # b",
            "#define E2 /*c*/",
            "#define F2(x)x+1",
            "#define O (x)",
            "#define F3( a , b ) a\t+\tb",
            "#define F5( ) 2",
            "#define V2(a,...) a __VA_ARGS__",
            "#define W(a, rest...) g(a, rest)",
            "#define P(a,b) a##b",
            "#define Q(a, b) a## b c",
            "#define LONG 1 /* multi\nline */ + 2",
            "int after;",
            "#undef  Q  junk",
            "#pragma   GCC   optimize   ( \"O2\" )  // x",
            '#ident\t"t"  ',
            "  /* c */ #define NOTDIR 1",
            "# 100",
            "int at100;",
            "",
        ].join("\n");
        expect(preprocessFpreprocessed(src, "m.txt")).toBe(
            [
                '# 1 "m.txt"',
                "#define S1(x) #x",
                "#define S2(x) a #x",
                "#define S3(x) a#x",
                "#define S4 a # b",
                "#define E2 ",
                "#define F2(x) x+1",
                "#define O (x)",
                "#define F3(a,b) a + b",
                "#define F5() 2",
                "#define V2(a,...) a __VA_ARGS__",
                "#define W(a,rest...) g(a, rest)",
                "#define P(a,b) a ##b",
                "#define Q(a,b) a ## b c",
                "#define LONG 1 + 2",
                "",
                "int after;",
                "#undef Q",
                '#pragma GCC optimize ( "O2" )',
                '#ident "t"',
                "          #define NOTDIR 1",
                '# 100 "m.txt"',
                "int at100;",
                "",
            ].join("\n"),
        );
    });

    test("strings, chars, digit separators, raw strings, unterminated", () => {
        const src = 'const char* s = "a  //b /* c */  \\"q\\"  ";\nchar q = \'"\'; char r = \'\\\'\';\nlong n = 1\'000\'000;\nconst char* raw = R"xy(raw  // not\n  comment  )xy";\nconst char* ml = "abc\\\ndef";\nchar u = \'ab  \n';
        expect(preprocessFpreprocessed(src, "s")).toBe('# 1 "s"\n' + src.replace("char u = 'ab  \n", "char u = 'ab  \n"));
    });

    test("lines inside raw strings count", () => {
        expect(preprocessFpreprocessed('int a = R"(x\ny\nz)"; int b;\nint c = R"(q\n)"\n;\n\n\nint d;\n', "r")).toBe('# 1 "r"\nint a = R"(x\ny\nz)"; int b;\nint c = R"(q\n)"\n;\n\n\nint d;\n');
    });

    test("CRLF and lone CR are newlines", () => {
        expect(preprocessFpreprocessed("int crlf = 1;\r\n  int crlf2;\r\n\r\nint lonecr;\rint after;\n#define CR 1\r\nint z;", "t2")).toBe(
            '# 1 "t2"\nint crlf = 1;\n  int crlf2;\n\nint lonecr;\nint after;\n#define CR 1\nint z;\n',
        );
    });

    test("constructs gcc handles specially are refused", () => {
        expect(() => preprocessFpreprocessed("#pragma once\n")).toThrow(PreprocessUnsupportedError);
        expect(() => preprocessFpreprocessed("#foo\n")).toThrow(PreprocessUnsupportedError);
        expect(() => preprocessFpreprocessed("/* open\n")).toThrow(PreprocessUnsupportedError);
    });
});
