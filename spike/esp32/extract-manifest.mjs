#!/usr/bin/env node
// Phase-0 spike: turn the native gcc driver's expansion (`xtensa-esp32-elf-g++ … -###`) of the
// sketch compile and the firmware link into driver-free command lines for cc1plus, as and ld.
// This is what Phase 1 stores in the board manifest. Absolute paths become placeholders:
//   ${PKG}  PlatformIO packages dir      ${SRC} sketch .cpp     ${ASM} cc1plus output
//   ${OBJ}  sketch object               ${ELF} firmware.elf    ${BUILD} pio build dir
//
//   node extract-manifest.mjs <driver_compile.txt> <driver_link.txt> <packagesDir> [board] > manifest.<board>.json
// board: esp32dev (default) | esp32-s3-devkitc-1 | esp32-c3-devkitm-1 (see BOARDS below)
import { readFileSync } from "node:fs";

const [compileTxt, linkTxt, pkg, board = "esp32dev"] = process.argv.slice(2);

/** Split one `-###` line (every argument double-quoted, or bare). */
function splitArgs(line) {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
    return out;
}
// Per board: native toolchain package + target, and esptool's elf2image flags as pio passes them.
const BOARDS = {
    "esp32dev": { chip: "esp32", toolchain: "toolchain-xtensa-esp32", target: "xtensa-esp32-elf",
        elf2image: ["--chip", "esp32", "elf2image", "--flash_mode", "dio", "--flash_freq", "40m", "--flash_size", "4MB", "--elf-sha256-offset", "0xb0"] },
    "esp32-s3-devkitc-1": { chip: "esp32s3", toolchain: "toolchain-xtensa-esp32s3", target: "xtensa-esp32s3-elf",
        elf2image: ["--chip", "esp32s3", "elf2image", "--flash_mode", "dio", "--flash_freq", "80m", "--flash_size", "8MB", "--elf-sha256-offset", "0xb0"] },
    "esp32-c3-devkitm-1": { chip: "esp32c3", toolchain: "toolchain-riscv32-esp", target: "riscv32-esp-elf",
        elf2image: ["--chip", "esp32c3", "elf2image", "--flash_mode", "dio", "--flash_freq", "80m", "--flash_size", "4MB", "--elf-sha256-offset", "0xb0"] },
};
const B = BOARDS[board];
if (!B) throw new Error(`unknown board ${board}`);
const buildDir = `.pio/build/${board}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lines = (f) => readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith(" "));
const find = (f, needle) => splitArgs(lines(f).find((l) => l.includes(needle)));
const norm = (p) => p.split(pkg).join("${PKG}").replace(/\/bin\/\.\.\//g, "/");

// --- cc1plus ------------------------------------------------------------------------------
const cc = find(compileTxt, "/cc1plus ").slice(1).map(norm);
const ccArgs = [];
for (let i = 0; i < cc.length; i++) {
    const a = cc[i];
    if (a === "-MMD" || a === "-MQ") { i++; continue; }        // dependency file: not needed
    if (a === "-o") { ccArgs.push("-o", "${ASM}"); i++; continue; }
    if (a.endsWith(".keep") || a.endsWith(".cpp")) { ccArgs.push("${SRC}"); continue; }
    if (a === "-dumpbase") { ccArgs.push(a, "${SRC_BASE}"); i++; continue; }
    if (a === "-auxbase-strip") { ccArgs.push(a, "${OBJ}"); i++; continue; }
    ccArgs.push(a);
}
// --- as -----------------------------------------------------------------------------------
const as = find(compileTxt, "/as ").slice(1).map(norm);
const asArgs = [];
for (let i = 0; i < as.length; i++) {
    if (as[i] === "-o") { asArgs.push("-o", "${OBJ}"); i++; continue; }
    if (as[i].endsWith(".s")) { asArgs.push("${ASM}"); continue; }
    asArgs.push(as[i]);
}
// --- ld (collect2 minus collect2's own options; no LTO, ELF has .init_array: collect2 just runs ld)
const ld = find(linkTxt, "/collect2 ").slice(1).map(norm);
const ldArgs = [];
for (let i = 0; i < ld.length; i++) {
    const a = ld[i];
    if (a === "-fno-lto") continue;
    if (a === "--cref" || a.startsWith("-Map=")) continue;     // map file: TS size report reads the ELF
    if (a === "-o") { ldArgs.push("-o", "${ELF}"); i++; continue; }
    if (new RegExp(`^${esc(buildDir)}/src/[^/]+\\.o$`).test(a)) { ldArgs.push("${OBJ}"); continue; }
    ldArgs.push(a.replace(new RegExp(`^${esc(buildDir)}`), "${BUILD}").replace(new RegExp(`^-L${esc(buildDir)}`), "-L${BUILD}"));
}

process.stdout.write(JSON.stringify({
    board,
    chip: B.chip,
    platform: "espressif32@7.1.3",
    toolchain: `${B.toolchain}@8.4.0+2021r2-patch5`,
    toolchainDir: B.toolchain,
    target: B.target,
    framework: "framework-arduinoespressif32@4.20017.260907 (Arduino-ESP32 2.0.17, IDF 4.4.7)",
    cc1plus: ccArgs,
    as: asArgs,
    ld: ldArgs,
    elf2image: B.elf2image,
}, null, 1) + "\n");
