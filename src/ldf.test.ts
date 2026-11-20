import { describe, expect, test } from "bun:test";
import { scanIncludes, selectLibraries } from "./ldf";
import type { LibraryEntry } from "./manifest";

const lib = (name: string, headers: string[], deps: string[] = [], archive = true): LibraryEntry => ({
    name,
    origin: "allowed",
    includeDirs: [`/opt/pio-libs/all/${name}`],
    headers,
    deps,
    ...(archive ? { archive: { path: `.pio/build/uno/lib0/lib${name}.a`, file: "x", size: 0, sha256: "" } } : {}),
});

// The uno pack's graph (PlatformIO's dependency graph, see pack/build.ts).
const LIBS = [
    lib("Wire", ["Wire.h", "utility/twi.h"]),
    lib("SPI", ["SPI.h"]),
    lib("Adafruit BusIO", ["Adafruit_I2CDevice.h", "Adafruit_SPIDevice.h"], ["Wire", "SPI"]),
    lib("Adafruit GFX Library", ["Adafruit_GFX.h", "Fonts/FreeSans9pt7b.h"], ["Adafruit BusIO", "SPI", "Wire"]),
    lib("Adafruit SSD1306", ["Adafruit_SSD1306.h"], ["Adafruit GFX Library", "SPI", "Wire"]),
    lib("EEPROM", ["EEPROM.h"], [], false),
];

describe("scanIncludes", () => {
    test("finds includes in order, skips comments, keeps conditionals", () => {
        const src = `#include <Arduino.h>\n// #include <Nope.h>\n/* #include <Nope2.h>\n*/\n  #  include "local.h"\n#if 0\n#include <Wire.h>\n#endif\nconst char* s = "#include <Str.h>";\n`;
        expect(scanIncludes(src).map((i) => i.name)).toEqual(["Arduino.h", "local.h", "Wire.h"]);
    });
});

describe("selectLibraries (PlatformIO chain mode)", () => {
    test("dependencies first in link order, include dirs in reverse", () => {
        const r = selectLibraries([{ path: "main.ino.cpp", content: "#include <Arduino.h>\n#include <Adafruit_SSD1306.h>\n" }], LIBS);
        expect(r.libraries.map((l) => l.name)).toEqual(["Wire", "SPI", "Adafruit BusIO", "Adafruit GFX Library", "Adafruit SSD1306"]);
        expect(r.includeArgs.filter((a) => a !== "-I")).toEqual(["Adafruit SSD1306", "Adafruit GFX Library", "Adafruit BusIO", "SPI", "Wire"].map((n) => `/opt/pio-libs/all/${n}`));
        expect(r.unresolved).toEqual(["Arduino.h"]);
    });
    test("follows the project's own headers (queued behind the sources); includes sorted per file like SCons", () => {
        // pio run on uno: graph SPI, EEPROM, Adafruit GFX Library (SPI from main.ino.cpp first,
        // conf.h is scanned after it)
        const r = selectLibraries(
            [
                { path: "main.ino.cpp", content: '#include "conf.h"\n#include <SPI.h>\n' },
                { path: "conf.h", content: "#include <EEPROM.h>\n#include <Fonts/FreeSans9pt7b.h>\n" },
            ],
            LIBS,
        );
        expect(r.libraries.map((l) => l.name)).toEqual(["SPI", "EEPROM", "Wire", "Adafruit BusIO", "Adafruit GFX Library"]);
    });
    test("top level in sorted include order, not source order (Adafruit SSD1306 example ssd1306_128x32_spi)", () => {
        // pio run on uno: graph GFX, SSD1306, SPI, Wire → link Wire, SPI, BusIO, GFX, SSD1306
        const r = selectLibraries([{ path: "x.ino.cpp", content: "#include <Arduino.h>\n#include <SPI.h>\n#include <Wire.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\n" }], LIBS);
        expect(r.libraries.map((l) => l.name)).toEqual(["Wire", "SPI", "Adafruit BusIO", "Adafruit GFX Library", "Adafruit SSD1306"]);
    });
});

describe("selectLibraries with scan data (PlatformIO's LDF step by step)", () => {
    // Adafruit BusIO as on pioarduino: the order of its dependencies follows the files the
    // sketch reaches first. pio run (esp32-s3, BusIO example spi_modetest): SPI, Wire, BusIO.
    const root = (n: string) => `/opt/pio-libs/all/${n}`;
    const scanned = (name: string, files: Record<string, string[]>, order: number): LibraryEntry => ({
        name,
        origin: "allowed",
        includeDirs: [root(name)],
        headers: Object.keys(files).filter((f) => f.endsWith(".h")),
        deps: [],
        objects: [],
        scan: { root: root(name), files, sources: Object.keys(files).filter((f) => f.endsWith(".cpp")), order },
    });
    const LIBS2 = [
        scanned("Adafruit BusIO", {
            "Adafruit_BusIO_Register.h": ['"Adafruit_GenericDevice.h', '"Adafruit_I2CDevice.h', '"Adafruit_SPIDevice.h', "<Arduino.h"],
            "Adafruit_BusIO_Register.cpp": ['"Adafruit_BusIO_Register.h'],
            "Adafruit_GenericDevice.h": ["<Arduino.h"],
            "Adafruit_I2CDevice.h": ["<Arduino.h", "<Wire.h"],
            "Adafruit_I2CDevice.cpp": ['"Adafruit_I2CDevice.h'],
            "Adafruit_SPIDevice.h": ["<Arduino.h", "<SPI.h"],
            "Adafruit_SPIDevice.cpp": ['"Adafruit_SPIDevice.h'],
        }, 0),
        scanned("SPI", { "SPI.h": [], "SPI.cpp": ['"SPI.h'] }, 1),
        scanned("Wire", { "Wire.h": [], "Wire.cpp": ['"Wire.h'] }, 2),
    ];
    test("a sketch reaching BusIO through the SPI device: SPI first", () => {
        const r = selectLibraries([{ path: "main.ino.cpp", content: "#include <Adafruit_SPIDevice.h>\n" }], LIBS2);
        expect(r.libraries.map((l) => l.name)).toEqual(["SPI", "Wire", "Adafruit BusIO"]);
    });
    test("… through the I2C device: Wire first", () => {
        const r = selectLibraries([{ path: "main.ino.cpp", content: "#include <Adafruit_I2CDevice.h>\n" }], LIBS2);
        expect(r.libraries.map((l) => l.name)).toEqual(["Wire", "SPI", "Adafruit BusIO"]);
    });
});
