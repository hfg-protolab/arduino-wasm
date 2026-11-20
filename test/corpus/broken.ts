/**
 * Deliberately broken sketches: native gcc/ld (via `pio run`) and the wasm toolchain must report
 * the same errors (file, line, column, message) for the same file names.
 */
export interface BrokenSketch {
    id: string;
    boards: string[];
    files: Array<{ path: string; content: string }>;
}

const ALL = ["uno", "nano", "nano-old", "mega", "leonardo", "esp32dev", "esp32-s3", "esp32-c3", "esp32-c6", "nano-esp32", "nodemcu", "d1-mini"];
const SOME = ["uno", "leonardo", "esp32dev", "esp32-c3", "esp32-c6", "nano-esp32", "nodemcu"];
const ESP32 = ["esp32dev", "esp32-s3", "esp32-c3", "esp32-c6", "nano-esp32"];

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
        boards: ["uno", "nano", "leonardo"],
        files: [
            {
                path: "TooBig.ino",
                content:
                    "#include <avr/pgmspace.h>\n\nconst uint8_t big1[17000] PROGMEM = {1, 2, 3};\nconst uint8_t big2[17000] PROGMEM = {4, 5, 6};\n\nvoid setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.write(pgm_read_byte(&big1[analogRead(A0) * 16]));\n  Serial.write(pgm_read_byte(&big2[analogRead(A1) * 16]));\n}\n",
            },
        ],
    },
    {
        // Arduino-ESP32 2.x LEDC API, removed in 3.x (ledcAttach/ledcWrite(pin, …) instead)
        id: "ledc_2x_api",
        boards: ESP32,
        files: [{ path: "Ledc2x.ino", content: "const int LED = 2;\n\nvoid setup() {\n  ledcSetup(0, 5000, 8);\n  ledcAttachPin(LED, 0);\n}\n\nvoid loop() {\n  ledcWrite(0, 128);\n}\n" }],
    },
    {
        // the other family's WiFi header
        id: "esp8266_header_on_esp32",
        boards: ["esp32dev", "esp32-c6"],
        files: [{ path: "WrongFamily.ino", content: "#include <ESP8266WiFi.h>\n\nvoid setup() {\n  WiFi.begin(\"x\", \"y\");\n}\n\nvoid loop() {}\n" }],
    },
    {
        id: "esp32_header_on_esp8266",
        boards: ["nodemcu", "d1-mini"],
        files: [{ path: "WrongFamily.ino", content: "#include <Preferences.h>\n\nPreferences prefs;\n\nvoid setup() {\n  prefs.begin(\"x\");\n}\n\nvoid loop() {}\n" }],
    },
    {
        id: "too_big_esp8266",
        boards: ["nodemcu"],
        files: [{ path: "TooBig.ino", content: "const uint8_t big[1100000] PROGMEM = {1, 2, 3};\n\nvoid setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  Serial.write(pgm_read_byte(&big[analogRead(A0) * 1000]));\n}\n" }],
    },
];
