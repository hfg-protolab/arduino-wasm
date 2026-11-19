/**
 * Step 4 (plan decision 7): the header bundle per board = closure (`-M`) of every header a
 * sketch may include: Arduino.h, the public headers of the framework's built-in libraries
 * (Wire, SPI, WiFi, HTTPClient, …), every header of the allowed libraries (incl.
 * Adafruit GFX Fonts/*), and the C/C++ standard headers. Each candidate is preprocessed on
 * its own after `#include <Arduino.h>` (a candidate that does not exist or #errors on this
 * board is skipped). Upper bound for comparison: every header file under every -I dir.
 *
 *   node headers.ts → $SCRATCH/headers/<board>.json + summary on stdout
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { type LinkCapture } from "./capture.ts";
import { brotli, CONFIG, MB, PKG, SCRATCH, shellSplit, toolBin } from "./common.ts";

const CXX = "algorithm any array atomic bitset cassert cctype cerrno cfloat chrono cinttypes climits cmath complex condition_variable cstdarg cstddef cstdint cstdio cstdlib cstring ctime cwchar deque exception forward_list fstream functional initializer_list iomanip ios iosfwd iostream istream iterator limits list locale map memory mutex new numeric optional ostream queue random ratio regex set sstream stack stdexcept streambuf string string_view system_error thread tuple type_traits typeinfo unordered_map unordered_set utility valarray variant vector".split(" ");
const C = "assert.h ctype.h errno.h float.h inttypes.h limits.h math.h setjmp.h stdarg.h stdbool.h stddef.h stdint.h stdio.h stdlib.h string.h time.h wchar.h alloca.h strings.h sys/types.h sys/time.h unistd.h fcntl.h avr/io.h avr/pgmspace.h avr/interrupt.h avr/eeprom.h avr/wdt.h avr/sleep.h avr/power.h util/delay.h util/crc16.h".split(" ");

function walk(dir: string, out: string[] = [], depth = 0): string[] {
    if (!existsSync(dir) || depth > 6) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "examples" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out, depth + 1);
        else if (/\.(h|hpp|hh|inc|tcc)$/.test(e.name)) out.push(p);
    }
    return out;
}

function libDirs(arch: string): string[] {
    const fw = join(PKG, CONFIG.frameworkLibraries[arch]);
    const dirs: string[] = [];
    for (const root of [fw, join(SCRATCH, "libs/all"), join(SCRATCH, "libs", arch)]) {
        if (!existsSync(root)) continue;
        for (const l of readdirSync(root)) {
            const d = join(root, l);
            if (!statSync(d).isDirectory()) continue;
            dirs.push(existsSync(join(d, "src")) ? join(d, "src") : d);
        }
    }
    return dirs;
}

function deps(cmd: string, args: string[], src: string): Promise<string[] | null> {
    return new Promise((res) => {
        const p = spawn(cmd, [...args, "-M", "-x", "c++", "-"], { cwd: SCRATCH, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", () => {});
        p.on("close", (code) => {
            if (code !== 0) return res(null);
            const files = out.replace(/\\\n/g, " ").split(/:\s/).slice(1).join(" ").split(/(?<!\\)\s+/).map((f) => f.replace(/\\ /g, " ")).filter((f) => f && f !== "-");
            res(files);
        });
        p.stdin.end(src);
    });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
}

export interface HeaderBundle {
    board: string;
    files: Array<{ path: string; size: number; sha: string }>;
    candidates: number;
    included: number;
    upperBound: { files: number; bytes: number };
}

async function bundle(capId: string, board: string, arch: string): Promise<HeaderBundle> {
    const cap: LinkCapture = JSON.parse(readFileSync(join(SCRATCH, "cap", capId, "link.json"), "utf8"));
    const main = cap.compiles.find((c) => c.includes("src/main.ino.cpp.o"))!;
    const a = shellSplit(main);
    // Flags without -o/-c/source; include dirs made absolute.
    const flags: string[] = [];
    const incs: string[] = [];
    for (let i = 1; i < a.length; i++) {
        const x = a[i];
        if (x === "-o") { i++; continue; }
        if (x === "-c" || x === "-MMD" || x === "-MD" || x.endsWith(".cpp")) continue;
        if (x.startsWith("-I")) { const d = x.slice(2); incs.push(d.startsWith("/") ? d : join(cap.cwd, d)); continue; }
        if (x.startsWith("-iprefix") || x.startsWith("-iwithprefixbefore") || x.startsWith("@")) {
            // ESP32 passes the IDF include list via -iprefix + @file
            if (x.startsWith("@")) flags.push(x.startsWith("@/") ? x : "@" + join(cap.cwd, x.slice(1)));
            else flags.push(x);
            continue;
        }
        flags.push(x);
    }
    const libs = libDirs(arch);
    const allInc = [...incs, ...libs];
    const cmd = join(toolBin(cap.triple), `${cap.triple}-g++`);
    const args = [...flags, ...allInc.map((d) => `-I${d}`)];
    const cands = ["Arduino.h", ...C, ...(arch === "avr" ? [] : CXX), ...libs.flatMap((d) => walk(d).map((f) => relative(d, f)))];
    const uniq = [...new Set(cands)];
    const res = await pool(uniq, availableParallelism(), (h) => deps(cmd, args, `#include <Arduino.h>\n#include <${h}>\n`));
    const set = new Set<string>();
    let included = 0;
    res.forEach((r) => { if (r) { included++; r.forEach((f) => set.add(f.startsWith("/") ? f : join(cap.cwd, f))); } });
    const files = [...set].filter((f) => existsSync(f)).sort().map((f) => {
        const b = readFileSync(f);
        return { path: f, size: b.length, sha: createHash("sha256").update(b).digest("hex") };
    });
    // Upper bound: every header under every include dir (+ the compiler's system dirs).
    const sys = await new Promise<string[]>((r) => {
        const p = spawn(cmd, [...flags, "-E", "-v", "-x", "c++", "-"], { stdio: ["pipe", "pipe", "pipe"] });
        let e = "";
        p.stderr.on("data", (d) => (e += d));
        p.on("close", () => r(e.split("\n").filter((l) => l.startsWith(" /")).map((l) => l.trim())));
        p.stdin.end("");
    });
    const ub = new Set<string>();
    for (const d of [...allInc, ...sys]) walk(d).forEach((f) => ub.add(f));
    let ubBytes = 0;
    ub.forEach((f) => (ubBytes += statSync(f).size));
    return { board, files, candidates: uniq.length, included, upperBound: { files: ub.size, bytes: ubBytes } };
}

// One capture per board: the sketch named in config.headerBundle for the board's arch.
const boardDefArch = (id: string) => CONFIG.boards.find((b) => b.id === id)!.arch;
const BOARDS: Array<[string, string, string]> = CONFIG.boards.map((b) => [`${CONFIG.headerBundle[b.arch]}.${b.id}`, b.id, b.arch]);

if (import.meta.main) {
    mkdirSync(join(SCRATCH, "headers"), { recursive: true });
    const all: HeaderBundle[] = [];
    for (const [cap, board, arch] of BOARDS) {
        const b = await bundle(cap, board, arch);
        writeFileSync(join(SCRATCH, "headers", `${board}.json`), JSON.stringify(b, null, 1));
        const raw = b.files.reduce((n, f) => n + f.size, 0);
        const cat = Buffer.concat(b.files.map((f) => Buffer.concat([Buffer.from(`\n//@@ ${f.path}\n`), readFileSync(f.path)])));
        console.log(`${board}: ${b.included}/${b.candidates} candidates ok, closure ${b.files.length} files ${MB(raw)} MB raw, ${MB(brotli(cat))} MB brotli; upper bound (all headers in -I dirs) ${b.upperBound.files} files ${MB(b.upperBound.bytes)} MB`);
        all.push(b);
    }
    // Shared between esp32 / s3 / c3 (by content).
    const esp = all.filter((b) => boardDefArch(b.board) === "esp32");
    const shas = esp.map((b) => new Map(b.files.map((f) => [f.sha, f.size])));
    const union = new Map<string, number>();
    shas.forEach((m) => m.forEach((s, k) => union.set(k, s)));
    let inAll = 0, unionBytes = 0;
    union.forEach((s, k) => { unionBytes += s; if (shas.every((m) => m.has(k))) inAll += s; });
    const sumEach = esp.reduce((n, b) => n + b.files.reduce((m, f) => m + f.size, 0), 0);
    console.log(`ESP32 family: sum of 3 bundles ${MB(sumEach)} MB, content-union ${MB(unionBytes)} MB, in all three ${MB(inAll)} MB (${((inAll / unionBytes) * 100).toFixed(0)} % of union)`);
    // AVR: the three boards
    const avr = all.filter((b) => boardDefArch(b.board) === "avr");
    const same = avr.every((b) => JSON.stringify(b.files.map((f) => f.sha)) === JSON.stringify(avr[0].files.map((f) => f.sha)));
    console.log(`AVR: the three bundles identical: ${same}`);
}
