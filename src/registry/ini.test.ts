import { describe, expect, test } from "bun:test";
import { parseMultiValues, parsePlatformioIni, setLibDeps } from "./ini";

// Expected values below were produced by PlatformIO 6.2's ProjectConfig on the same text.
const FULL =
    '; PlatformIO Project Configuration File\n[platformio]\ndefault_envs = uno\n\n[common]\nlib_deps_ext =\n    bblanchon/ArduinoJson @ ^6.21.0 ; json\n    # a comment\n\n    knolleary/PubSubClient@2.8\nflags = -DCOMMON=1\n\n[env]\nframework = arduino\nbuild_flags =\n    -DFOO=1\n    -DBAR="a b" ; trailing\n    ${common.flags}\nlib_deps = adafruit/Adafruit Unified Sensor, SPI\nlib_ldf_mode = deep+\n\n[env:uno]\nplatform = atmelavr\nboard = uno\nbuild_flags = ${env.build_flags} -DUNO\nlib_deps =\n    ${common.lib_deps_ext}\n    adafruit/Adafruit BME280 Library@^2.3.0\n    https://github.com/x/y.git#v1.0\nlib_ignore = Foo, Bar\nupload_speed = 115200\nboard_build.f_cpu = 16000000L\nextra_scripts = pre:x.py\ncustom_x = 1\nlib_archive = no\n\n[env:other]\nplatform = espressif32\n';

describe("parsePlatformioIni", () => {
    test("[env] + first [env:*], ${…} interpolation, multi-line values with comments", () => {
        const r = parsePlatformioIni(FULL);
        expect(r.errors).toEqual([]);
        expect(r.sections.map((s) => s.name)).toEqual(["platformio", "common", "env", "env:uno", "env:other"]);
        expect(r.sections[1]!.options[0]).toEqual({ key: "lib_deps_ext", value: "\nbblanchon/ArduinoJson @ ^6.21.0\n\nknolleary/PubSubClient@2.8" });
        expect(r.env).toEqual({
            name: "uno",
            platform: "atmelavr",
            board: "uno",
            framework: "arduino",
            frameworks: ["arduino"],
            libDeps: ["bblanchon/ArduinoJson @ ^6.21.0", "knolleary/PubSubClient@2.8", "adafruit/Adafruit BME280 Library@^2.3.0", "https://github.com/x/y.git#v1.0"],
            buildFlags: ["-DFOO=1", '-DBAR="a b"', "-DCOMMON=1 -DUNO"],
            libIgnore: ["Foo", "Bar"],
            libLdfMode: "deep+",
            libArchive: "false",
            unsupported: ["board_build.f_cpu", "extra_scripts"],
        });
    });

    test("extends chain, ${this.*}, old option names", () => {
        const r = parsePlatformioIni(
            "[base]\nplatform = atmelavr\nbuild_flags = -DBASE\nlib_deps = Base1, Base2\n\n[mid]\nextends = base\nboard = nano\n\n[env:x]\nextends = mid\nbuild_flags = ${this.build_flags_extra} -DENV=${this.__env__}\nbuild_flags_extra = -DX\nlib_use = Legacy\nsrc_filter = +<*>\n",
        );
        expect(r.errors).toEqual([]);
        expect(r.env).toMatchObject({ name: "x", platform: "atmelavr", board: "nano", libDeps: ["Legacy"], buildFlags: ["-DX -DENV=x"] });
        expect(r.env.unsupported).toEqual(["build_flags_extra", "src_filter"]);
    });

    test("CRLF and %% escapes", () => {
        const r = parsePlatformioIni("[env:crlf]\r\nplatform = ststm32\r\nlib_deps =\r\n  A\r\n  B\r\nbuild_flags = -DPCT=100%% -DX\r\n");
        expect(r.errors).toEqual([]);
        expect(r.env).toMatchObject({ name: "crlf", platform: "ststm32", libDeps: ["A", "B"], buildFlags: ["-DPCT=100% -DX"] });
    });

    test("[DEFAULT] and %(key)s", () => {
        const r = parsePlatformioIni("[DEFAULT]\nshared = 1\n[env:d]\nplatform = p\nbuild_flags = -DV=%(shared)s\nlib_compat_mode = strict\n");
        expect(r.env).toMatchObject({ buildFlags: ["-DV=1"], libCompatMode: "strict" });
    });

    test("single-line values split on ', ' only; [env] alone has name null", () => {
        const r = parsePlatformioIni("[env]\nlib_deps = a,b\nbuild_flags = -DA, -DB\nframework = arduino, mbed\n");
        expect(r.env).toMatchObject({ name: null, libDeps: ["a,b"], buildFlags: ["-DA", "-DB"], frameworks: ["arduino", "mbed"], framework: "arduino, mbed" });
    });

    test("inline comments need whitespace, comment lines inside values are skipped", () => {
        const r = parsePlatformioIni("[env:u]\nlib_deps = A ;c1\n  B#notcomment\n\n  ; full comment\n  C ; c2\n   \nbuild_flags = -Da # x\nlib_ldf_mode = bogus\n");
        expect(r.env.libDeps).toEqual(["A", "B#notcomment", "C"]);
        expect(r.env.buildFlags).toEqual(["-Da"]);
        expect(r.env.libLdfMode).toBeUndefined();
        expect(r.errors).toEqual([{ line: 9, message: "'bogus' is not one of 'off', 'chain', 'deep', 'chain+', 'deep+'. for `lib_ldf_mode` option in the `env:u` section" }]);
    });

    test("syntax errors carry line numbers", () => {
        expect(parsePlatformioIni("platform = x\n[env:a]\nboard = b\n").errors).toEqual([{ line: 1, message: "File contains no section headers." }]);
        const r = parsePlatformioIni("[env:a]\nboard = b\nboard = c\n[env:a]\nnovalue\nbuild_flags = -DX=50%\n");
        expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
        expect(r.env.board).toBe("c");
    });

    test("interpolation errors: recursion, missing section; built-ins stay for SCons", () => {
        const r = parsePlatformioIni(
            "[env:a]\nbuild_flags = ${env:a.build_flags} -DX\nlib_deps = ${common.nope}\nplatform = ${this.board}-p\nboard = ${sysenv.HOME}b\nframework = ${PROJECT_DIR}\n",
        );
        expect(r.errors).toEqual([
            { line: 2, message: "Infinite recursion has been detected for `build_flags` option in the `env:a` section" },
            { line: 3, message: "No section: 'common'" },
        ]);
        expect(r.env).toMatchObject({ platform: "b-p", board: "b", frameworks: ["${PROJECT_DIR}"] });
    });

    test("unset env options render as None like Python", () => {
        const r = parsePlatformioIni("[env:a]\nbuild_flags = -DP=${env:a.upload_port}\n");
        expect(r.env.buildFlags).toEqual(["-DP=None"]);
    });

    test("extends cycles are reported instead of hanging", () => {
        const r = parsePlatformioIni("[env:b]\nextends = env:c\n[env:c]\nextends = env:b\nboard = x\n");
        expect(r.env.board).toBe("x");
        expect(r.errors.some((e) => e.message.includes("extends"))).toBe(true);
    });

    test("no env at all", () => {
        const r = parsePlatformioIni("[platformio]\nsrc_dir = x\n");
        expect(r.env).toEqual({ name: null, frameworks: [], libDeps: [], buildFlags: [], libIgnore: [], unsupported: [] });
    });

    test("parseMultiValues", () => {
        expect(parseMultiValues("a, b,c")).toEqual(["a", "b,c"]);
        expect(parseMultiValues("\na ; x\n; c\n#d\n\nb;c")).toEqual(["a", "b;c"]);
        expect(parseMultiValues("")).toEqual([]);
    });
});

describe("setLibDeps", () => {
    test("replaces a multi-line value, keeps everything else byte for byte", () => {
        const out = setLibDeps(FULL, ["a/B@^1.0.0", "C"]);
        expect(out).toBe(
            FULL.replace(
                "lib_deps =\n    ${common.lib_deps_ext}\n    adafruit/Adafruit BME280 Library@^2.3.0\n    https://github.com/x/y.git#v1.0\n",
                "lib_deps =\n    a/B@^1.0.0\n    C\n",
            ),
        );
        expect(parsePlatformioIni(out).env.libDeps).toEqual(["a/B@^1.0.0", "C"]);
    });

    test("round trip: add, replace, remove", () => {
        const base = "; top\n[env:uno]\nplatform = atmelavr\nboard = uno ; the board\n\n[env:other]\nplatform = x\n";
        const added = setLibDeps(base, ["A", "B"]);
        expect(added).toBe("; top\n[env:uno]\nplatform = atmelavr\nboard = uno ; the board\nlib_deps =\n    A\n    B\n\n[env:other]\nplatform = x\n");
        const replaced = setLibDeps(added, ["X"]);
        expect(replaced).toBe("; top\n[env:uno]\nplatform = atmelavr\nboard = uno ; the board\nlib_deps =\n    X\n\n[env:other]\nplatform = x\n");
        expect(setLibDeps(replaced, [])).toBe(base);
        expect(setLibDeps(base, [])).toBe(base);
    });

    test("keeps the existing indentation and comments after the value", () => {
        const text = "[env:a]\nlib_deps =\n\tOld1\n\t; note\n\tOld2\n; after\nboard = b";
        expect(setLibDeps(text, ["New"])).toBe("[env:a]\nlib_deps =\n\tNew\n; after\nboard = b");
    });

    test("value at end of file without newline", () => {
        expect(setLibDeps("[env:a]\nlib_deps = Old", ["N1", "N2"])).toBe("[env:a]\nlib_deps =\n    N1\n    N2");
        expect(setLibDeps("[env:a]\nboard = b", ["N"])).toBe("[env:a]\nboard = b\nlib_deps =\n    N\n");
    });

    test("CRLF files get CRLF lines", () => {
        expect(setLibDeps("[env:a]\r\nboard = b\r\n", ["N"])).toBe("[env:a]\r\nboard = b\r\nlib_deps =\r\n    N\r\n");
    });

    test("empty list overrides inherited deps instead of removing", () => {
        const text = "[env]\nlib_deps = A\n[env:a]\nlib_deps = B\n";
        const out = setLibDeps(text, []);
        expect(out).toBe("[env]\nlib_deps = A\n[env:a]\nlib_deps =\n");
        expect(parsePlatformioIni(out).env.libDeps).toEqual([]);
    });

    test("falls back to [env], then appends a new [env]", () => {
        expect(setLibDeps("[env]\nframework = arduino\n", ["A"])).toBe("[env]\nframework = arduino\nlib_deps =\n    A\n");
        expect(setLibDeps("[platformio]\nsrc_dir = s\n", ["A"])).toBe("[platformio]\nsrc_dir = s\n\n[env]\nlib_deps =\n    A\n");
        expect(setLibDeps("", ["A"])).toBe("[env]\nlib_deps =\n    A\n");
        expect(setLibDeps("[platformio]", [])).toBe("[platformio]");
    });
});
