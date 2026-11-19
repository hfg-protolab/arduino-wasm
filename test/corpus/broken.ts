/**
 * Deliberately broken sketches: native gcc/ld (via `pio run`) and the wasm toolchain must report
 * the same errors (file, line, column, message) for the same file names.
 */
export interface BrokenSketch {
    id: string;
    boards: string[];
    files: Array<{ path: string; content: string }>;
}

const ALL = ["uno", "nano", "nano-old", "esp32dev", "esp32-s3", "esp32-c3"];
const SOME = ["uno", "esp32dev", "esp32-c3"];

export const BROKEN: BrokenSketch[] = [
    {
        id: "missing_semicolon",
        boards: SOME,
        files: [{ path: "MissingSemicolon.ino", content: "void setup() {\n  pinMode(13, OUTPUT)\n  digitalWrite(13, HIGH);\n}\n\nvoid loop() {}\n" }],
    },
    {
        id: "undeclared_identifier",
        boards: ALL,
        files: [{ path: "Undeclared.ino", content: "int counter = 0;\n\nvoid setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  counter += stepSize;\n  Serial.println(countr);\n}\n" }],
    },
    {
        id: "wrong_include",
        boards: SOME,
        files: [{ path: "WrongInclude.ino", content: "#include <Wire.h>\n#include <Adafruit_SSD1306_typo.h>\n\nvoid setup() {}\nvoid loop() {}\n" }],
    },
    {
        id: "error_in_tab",
        boards: SOME,
        files: [
            { path: "Tabs.ino", content: '#include "helper.h"\n\nvoid setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(helper(2));\n}\n' },
            { path: "helper.h", content: "#pragma once\nint helper(int x);\n" },
            { path: "helper.cpp", content: '#include "helper.h"\n\nint helper(int x) {\n  int y = x * 2\n  return y;\n}\n' },
        ],
    },
    {
        id: "type_error",
        boards: SOME,
        files: [{ path: "TypeError.ino", content: 'void setup() {\n  Serial.begin(9600);\n  int x = "text";\n  String s = 5.0f;\n  s.nope();\n}\n\nvoid loop() {}\n' }],
    },
    {
        id: "undefined_reference",
        boards: SOME,
        files: [{ path: "Undefined.ino", content: "void notDefinedAnywhere(int);\nextern int alsoMissing;\n\nvoid setup() {\n  notDefinedAnywhere(alsoMissing);\n}\n\nvoid loop() {}\n" }],
    },
    {
        id: "too_big_uno",
        boards: ["uno", "nano"],
        files: [
            {
                path: "TooBig.ino",
                content:
                    "#include <avr/pgmspace.h>\n\nconst uint8_t big1[17000] PROGMEM = {1, 2, 3};\nconst uint8_t big2[17000] PROGMEM = {4, 5, 6};\n\nvoid setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.write(pgm_read_byte(&big1[analogRead(A0) * 16]));\n  Serial.write(pgm_read_byte(&big2[analogRead(A1) * 16]));\n}\n",
            },
        ],
    },
];
