/** Shared helpers of the link spike (Node only, no dependencies outside node:*). */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

export interface SpikeConfig {
    boards: Array<{ id: string; platform: string; board: string; arch: string }>;
    libraries: Array<{ dir: string; spec: string }>;
    frameworkLibraries: Record<string, string>;
    toolchains: Record<string, string>;
    sketches: Array<{ name: string; source?: string; boards: string[]; noLto?: boolean }>;
    headerBundle: Record<string, string>;
}

/** Inputs (boards, libraries, toolchains, sketches): config.json next to this file, or $LINK_CONFIG. */
export const CONFIG: SpikeConfig = JSON.parse(readFileSync(process.env.LINK_CONFIG ?? new URL("./config.json", import.meta.url), "utf8"));

/** Work dir for projects, logs, captures (big files). */
export const SCRATCH = process.env.LINK_SCRATCH ?? join(tmpdir(), "firmware-pack-link-spike");
/** PlatformIO packages dir (toolchains, frameworks). */
export const PKG = process.env.PLATFORMIO_PACKAGES_DIR ?? join(homedir(), ".platformio/packages");
export const PIO = process.env.PIO ?? join(homedir(), ".platformio/penv/bin/pio");

export const boardDef = (id: string) => {
    const b = CONFIG.boards.find((x) => x.id === id);
    if (!b) throw new Error(`board ${id} not in config`);
    return b;
};

export function toolBin(triple: string): string {
    const pkg = CONFIG.toolchains[triple];
    if (!pkg) throw new Error(`toolchain for ${triple} not in config`);
    return join(PKG, pkg, "bin");
}

/** Minimal shell-like split: whitespace, single and double quotes, backslash escapes. */
export function shellSplit(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let q: string | null = null;
    let has = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === q) q = null;
            else if (c === "\\" && q === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else cur += c;
        } else if (c === "\\" && i + 1 < line.length) { cur += line[++i]; }
        else if (c === '"' || c === "'") { q = c; has = true; }
        else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ""; has = false; }
        else cur += c;
    }
    if (cur || has) out.push(cur);
    return out;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { stdout: string; stderr: string; code: number } {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8", maxBuffer: 1 << 30 });
    if (r.error) throw r.error;
    return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
}

export function brotli(buf: Uint8Array): number {
    return brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
}

export function readBytes(p: string): Uint8Array {
    const b = readFileSync(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export const MB = (n: number) => (n / 1e6).toFixed(2);
