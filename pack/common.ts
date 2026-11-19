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
    arch: "avr" | "esp32";
    /** Directory name under .build/toolchains. */
    toolchain: string;
    chip?: "esp32" | "esp32s3" | "esp32c3";
    /** Build core/libraries without -flto (decision 9). */
    noLto?: boolean;
    /** Generate a PCH of the Arduino.h prologue. */
    pch?: boolean;
    /** Split the framework archives into members + symbol index (lazy linking). */
    lazyLink?: boolean;
}

export interface PackConfig {
    packVersion: string;
    virtualRoots: { packages: string; libs: string; project: string };
    boards: BoardConfig[];
    libraries: Array<{ dir: string; spec: string }>;
    extraHeaders: Record<string, string[]>;
    stdHeaders: { c: string; cxx: string; avr: string };
}

export function loadConfig(path = join(REPO, "pack/config.json")): PackConfig {
    return JSON.parse(readFileSync(path, "utf8"));
}

/** Work dir: pio projects, logs, installed libraries. */
export const WORK = process.env.PACK_WORK ?? join(REPO, ".build/pack-work");
/**
 * PlatformIO install: a developer's ~/.platformio, or the pio-image (pack/pio-image), whose
 * PLATFORMIO_CORE_DIR=/opt/pio and pio on PATH. PLATFORMIO_PACKAGES_DIR / PIO override.
 */
const CORE = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio");
export const PKG = process.env.PLATFORMIO_PACKAGES_DIR ?? join(CORE, "packages");
export const PIO = process.env.PIO ?? (existsSync(join(CORE, "penv/bin/pio")) ? join(CORE, "penv/bin/pio") : "pio");
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

export function toolchainPackage(arch: string, chip?: string): string {
    if (arch === "avr") return "toolchain-atmelavr";
    if (chip === "esp32c3") return "toolchain-riscv32-esp";
    return chip === "esp32s3" ? "toolchain-xtensa-esp32s3" : "toolchain-xtensa-esp32";
}

export function triple(arch: string, chip?: string): string {
    if (arch === "avr") return "avr";
    if (chip === "esp32c3") return "riscv32-esp-elf";
    return chip === "esp32s3" ? "xtensa-esp32s3-elf" : "xtensa-esp32-elf";
}

export const nativeTool = (b: BoardConfig, tool: string) => join(PKG, toolchainPackage(b.arch, b.chip), "bin", `${triple(b.arch, b.chip)}-${tool}`);

export const exists = existsSync;
export const MB = (n: number) => (n / 1e6).toFixed(2);
