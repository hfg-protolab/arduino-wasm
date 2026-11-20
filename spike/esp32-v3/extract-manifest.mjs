#!/usr/bin/env node
// Toolchain spike (GCC 14 / Arduino-ESP32 3.x, and GCC 10.3 / ESP8266): turn the native gcc
// driver's expansion (`<target>-g++ … -###`) of the sketch compile and the firmware link into
// driver-free command lines for cc1plus, as and ld — what the board manifest will hold.
// Like spike/esp32/extract-manifest.mjs, but for any target and both GCC 10 and GCC 14 driver
// output (GCC 14: -dumpdir/-dumpbase/-dumpbase-ext, -MMD <file>; GCC 10: -auxbase-strip).
//
// Absolute paths become placeholders:
//   ${PKG}  PlatformIO packages dir      ${SRC} sketch .cpp     ${ASM} cc1plus output
//   ${OBJ}  sketch object               ${ELF} firmware.elf
// Everything else stays as the driver wrote it (paths relative to the project = cwd).
//
//   node extract-manifest.mjs <cc.txt> <ld.txt> <packagesDir> <board> > manifest.<board>.json
import { readFileSync } from "node:fs";

const [compileTxt, linkTxt, pkg, board] = process.argv.slice(2);
if (!board) throw new Error("usage: extract-manifest.mjs <cc.txt> <ld.txt> <packagesDir> <board>");

/** Split one `-###` line (every argument double-quoted, or bare). */
function splitArgs(line) {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
    return out;
}
const lines = (f) => readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith(" "));
const find = (f, needle) => {
    const l = lines(f).find((x) => x.includes(needle));
    if (!l) throw new Error(`${needle} not in ${f}`);
    return splitArgs(l);
};
const norm = (p) => p.split(pkg).join("${PKG}").replace(/\/bin\/\.\.\//g, "/");
const tmpS = (a) => /\/T\/\/?cc\w+\.s$|^\/tmp\/cc\w+\.s$/.test(a);

// --- cc1plus ------------------------------------------------------------------------------
const ccFull = find(compileTxt, "/cc1plus ");
const toolchainDir = ccFull[0].split(pkg + "/")[1].split("/")[0];
const target = ccFull[0].match(/\/libexec\/gcc\/([^/]+)\/([^/]+)\/cc1plus$/);
const cc = ccFull.slice(1).map(norm);
const ccArgs = [];
for (let i = 0; i < cc.length; i++) {
    const a = cc[i];
    if (a === "-MMD" || a === "-MQ" || a === "-MD" || a === "-MF") { i++; continue; }   // dependency file: not needed
    if (a === "-o") { ccArgs.push("-o", "${ASM}"); i++; continue; }
    // -dumpdir/-dumpbase/-dumpbase-ext (GCC 14) only name auxiliary outputs; kept verbatim.
    if (a === "-dumpdir" || a === "-dumpbase" || a === "-dumpbase-ext") { ccArgs.push(a, cc[++i]); continue; }
    if (a === "src/main.ino.cpp") { ccArgs.push("${SRC}"); continue; }
    if (a === "-auxbase-strip") { ccArgs.push(a, "${OBJ}"); i++; continue; }
    ccArgs.push(a);
}
// --- as -----------------------------------------------------------------------------------
const as = find(compileTxt, "/as ").slice(1).map(norm);
const asArgs = [];
for (let i = 0; i < as.length; i++) {
    if (as[i] === "-o") { asArgs.push("-o", "${OBJ}"); i++; continue; }
    if (tmpS(as[i])) { asArgs.push("${ASM}"); continue; }
    asArgs.push(as[i]);
}
// --- ld (collect2 minus collect2's/LTO plugin options; no LTO: collect2 just runs ld) --------
const ld = find(linkTxt, "/collect2 ").slice(1).map(norm);
const ldArgs = [];
for (let i = 0; i < ld.length; i++) {
    const a = ld[i];
    if (a === "-fno-lto") continue;
    if (a === "-plugin") { i++; continue; }
    if (a.startsWith("-plugin-opt=")) continue;
    if (a === "--cref" || a.startsWith("-Map=")) continue;     // map file: size report reads the ELF
    if (a === "-o") { ldArgs.push("-o", "${ELF}"); i++; continue; }
    if (/^\.pio\/build\/[^/]+\/src\/main\.ino\.cpp\.o$/.test(a)) { ldArgs.push("${OBJ}"); continue; }
    ldArgs.push(a);
}

process.stdout.write(JSON.stringify({
    board,
    toolchainDir,
    target: target[1],
    gccVersion: target[2],
    cc1plus: ccArgs,
    as: asArgs,
    ld: ldArgs,
}, null, 1) + "\n");
