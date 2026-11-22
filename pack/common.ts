/** Shared helpers of the pack builder (Node/Bun only). */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

export const REPO = process.env.ARDUINO_WASM_REPO ?? resolve(dirname(new URL(import.meta.url).pathname), "..");

export interface BoardConfig {
    id: string;
    name: string;
    platform: string;
    board: string;
    framework: string;
    arch: "avr" | "esp32" | "esp8266";
    /** Directory name under .build/toolchains. */
    toolchain: string;
    chip?: "esp32" | "esp32s3" | "esp32c3" | "esp32c6" | "esp8266";
    /** Build core/libraries without -flto (decision 9). */
    noLto?: boolean;
    /** Generate a PCH of the Arduino.h prologue. */
    pch?: boolean;
    /** Split the framework archives into members + symbol index (lazy linking). */
    lazyLink?: boolean;
    /**
     * Ship archives and objects as they are (no `--strip-debug`). Needed where ld generates
     * stubs: on avr6 (Mega 2560) the `.trampolines` come out in hash order of names made of
     * input section ids, and stripping debug sections from the crt object or a library member
     * shifts those ids, so the .hex would no longer match pio.
     */
    keepDebug?: boolean;
}

export interface PackConfig {
    packVersion: string;
    /**
     * The date behind SOURCE_DATE_EPOCH of every native build (default: the pack version's):
     * kept when a pack version reuses the cached probe builds, whose core it ships.
     */
    sourceDate?: string;
    virtualRoots: { packages: string; libs: string; project: string };
    boards: BoardConfig[];
    libraries: Array<{ dir: string; spec: string }>;
    extraHeaders: Record<string, string[]>;
    stdHeaders: { c: string; cxx: string; avr: string };
}

export function loadConfig(path = join(REPO, "pack/config.json")): PackConfig {
    return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Environment of every native PlatformIO build (probe and reference builds): SOURCE_DATE_EPOCH =
 * midnight UTC of the pack version's date. Arduino-ESP32 3.x's core prints its build time
 * (`__DATE__`/`__TIME__`, chip-debug-report.cpp); the pack ships that core precompiled, so the
 * reference builds must expand those macros to the same instant (GCC honours SOURCE_DATE_EPOCH).
 */
export function pioEnv(cfg: Pick<PackConfig, "packVersion" | "sourceDate">): NodeJS.ProcessEnv {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(cfg.sourceDate ?? cfg.packVersion);
    const epoch = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 1000 : 0;
    return { ...process.env, SOURCE_DATE_EPOCH: String(epoch) };
}

/** Work dir: pio projects, logs, installed libraries. */
export const WORK = process.env.PACK_WORK ?? join(REPO, ".build/pack-work");
/**
 * PlatformIO install: a developer's ~/.platformio, or the pio-image (pack/pio-image), whose
 * PLATFORMIO_CORE_DIR=/opt/pio and pio on PATH. PLATFORMIO_PACKAGES_DIR / PIO override.
 */
const CORE = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio");
export const PLATFORMS = process.env.PLATFORMIO_PLATFORMS_DIR ?? join(CORE, "platforms");
export const PKG = process.env.PLATFORMIO_PACKAGES_DIR ?? join(CORE, "packages");
// (with PLATFORMIO_CORE_DIR set — the pio-image — `pio` on PATH: pioarduino puts its own
// PlatformIO into <core>/penv, which is not the pinned one)
export const PIO = process.env.PIO ?? (!process.env.PLATFORMIO_CORE_DIR && existsSync(join(CORE, "penv/bin/pio")) ? join(CORE, "penv/bin/pio") : "pio");
/**
 * Storage dir of the allowed libraries (`<dir>/all`, `<dir>/<arch>`, see "libraries" in
 * pack/config.json). Default: installed by the builder under WORK; the pio-image has them
 * preinstalled at /opt/pio-libs (PACK_LIBS), so library paths are the pack's virtual ones.
 */
export const LIBS = process.env.PACK_LIBS ?? join(WORK, "libs");
export const TOOLCHAINS = process.env.WASM_TOOLCHAINS ?? join(REPO, ".build/toolchains");

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: "utf8", maxBuffer: 1 << 30 });
    if (r.error) throw r.error;
    return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
}

export function runAsync(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((res, rej) => {
        const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.stderr.on("data", (d) => (stderr += d));
        p.on("error", rej);
        p.on("close", (code) => res({ stdout, stderr, code: code ?? 1 }));
        p.stdin.end(opts.input ?? "");
    });
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.max(1, n) }, async () => {
            while (i < items.length) {
                const k = i++;
                out[k] = await fn(items[k]!, k);
            }
        }),
    );
    return out;
}

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export function brotliSize(buf: Uint8Array): number {
    return brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
}

export function brotli(buf: Uint8Array): Uint8Array {
    return brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
}

export function readBytes(p: string): Uint8Array {
    const b = readFileSync(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Split one line of `gcc -###` output: every argument is double-quoted there (with \" and \\
 * escapes), the program name too. Bare words are accepted for robustness.
 */
export function splitDriverLine(line: string): string[] {
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!);
    return out;
}

/** Shell-like split of a `pio run -v` command line: whitespace, quotes, backslash escapes. */
export function shellSplit(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let q: string | null = null;
    let has = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (q) {
            if (c === q) q = null;
            else if (c === "\\" && q === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
            else cur += c;
        } else if (c === "\\" && i + 1 < line.length) cur += line[++i];
        else if (c === '"' || c === "'") {
            q = c;
            has = true;
        } else if (/\s/.test(c)) {
            if (cur || has) out.push(cur);
            cur = "";
            has = false;
        } else cur += c;
    }
    if (cur || has) out.push(cur);
    return out;
}

/** pioarduino (Arduino-ESP32 3.x, GCC 14): one xtensa toolchain for every chip, driven by dynconfig. */
export const isPioarduino = (platform: string) => /pioarduino|platform-espressif32\.zip/.test(platform);

type ToolchainOf = Pick<BoardConfig, "arch" | "chip" | "platform">;

export function toolchainPackage(b: ToolchainOf): string {
    if (b.arch === "avr") return "toolchain-atmelavr";
    if (b.arch === "esp8266") return "toolchain-xtensa";
    if (b.chip === "esp32c3" || b.chip === "esp32c6") return "toolchain-riscv32-esp";
    if (isPioarduino(b.platform)) return "toolchain-xtensa-esp-elf";
    return b.chip === "esp32s3" ? "toolchain-xtensa-esp32s3" : "toolchain-xtensa-esp32";
}

/** Prefix of the tools the build calls (the 3.x xtensa package has per-chip wrappers, e.g. xtensa-esp32-elf-objcopy). */
export function triple(b: ToolchainOf): string {
    if (b.arch === "avr") return "avr";
    if (b.arch === "esp8266") return "xtensa-lx106-elf";
    if (b.chip === "esp32c3" || b.chip === "esp32c6") return "riscv32-esp-elf";
    return b.chip === "esp32s3" ? "xtensa-esp32s3-elf" : "xtensa-esp32-elf";
}

export const nativeTool = (b: BoardConfig, tool: string) => join(PKG, toolchainPackage(b), "bin", `${triple(b)}-${tool}`);

export const exists = existsSync;
export const MB = (n: number) => (n / 1e6).toFixed(2);
