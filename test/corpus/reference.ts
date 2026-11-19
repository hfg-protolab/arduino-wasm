/**
 * Cached native reference builds for the corpus: `pio run` (test/reference-build.ts, same
 * platformio.ini as the AI Hub, AVR without LTO) in a few reused PlatformIO projects per board
 * (the framework is compiled once per project), results under
 * .build/corpus-ref/<packVersion>/<board>/<sketch>.<hash>/ keyed by pack version, board,
 * platformio.ini and the sketch files.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, PKG, REPO, sha256, WORK } from "../../pack/common.ts";
import { libsRoot, platformioIni } from "../../pack/probe.ts";
import { parseDiagnostics } from "../../src/diagnostics";
import type { Diagnostic } from "../../src/types";
import { pioRun, writeProject } from "../reference-build";

export const REF_ROOT = process.env.CORPUS_REF ?? join(REPO, ".build/corpus-ref");

export interface NativeRef {
    ok: boolean;
    /** Directory holding firmware.hex / firmware.bin, bootloader.bin, partitions.bin. */
    dir: string;
    /** pio's "RAM:"/"Flash:" numbers (when it got that far). */
    size?: { ram: number; ramMax: number; flash: number; flashMax: number };
    errors: Diagnostic[];
    /** The tail of the build log (failures). */
    logTail?: string;
    seconds: number;
    cached: boolean;
}

const OUT_FILES = ["firmware.hex", "firmware.bin", "bootloader.bin", "partitions.bin"];

/** Parses pio's size report lines ("RAM:   [...] 9.3% (used 190 bytes from 2048 bytes)"). */
export function pioSize(log: string): NativeRef["size"] {
    const ram = /^RAM:.*\(used (\d+) bytes from (\d+) bytes\)/m.exec(log);
    const flash = /^Flash:.*\(used (\d+) bytes from (\d+) bytes\)/m.exec(log);
    if (!ram || !flash) return undefined;
    return { ram: +ram[1]!, ramMax: +ram[2]!, flash: +flash[1]!, flashMax: +flash[2]! };
}

/** Errors of a native build log, mapped like the runtime maps its own (src/diagnostics.ts). */
export function nativeErrors(log: string, projectDir: string, files: Array<{ path: string }>): Diagnostic[] {
    const paths = new Map(files.map((f) => [`src/${f.path}`, f.path]));
    const ino = files.filter((f) => /\.(ino|pde)$/.test(f.path)).map((f) => f.path).sort();
    const { errors } = parseDiagnostics(log, {
        cwd: projectDir,
        paths,
        mainIno: ino[0] ?? null,
        strip: [new RegExp(`^${escapeRe(PKG)}/`), new RegExp(`^${escapeRe(libsRoot())}/[^/]+/`)],
    });
    // PlatformIO's own size check (the runtime reports it without the "Error: " prefix)
    for (const m of log.matchAll(/^Error: (The program size .*)$/gm)) errors.push({ file: null, line: null, column: null, message: m[1]!.trim() });
    return errors;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reference variants: "plain" is the AI Hub's platformio.ini; "file-map" additionally maps the
 * project dir to the pack's virtual one in `__FILE__` of the sketch's own sources
 * (`build_src_flags = -fmacro-prefix-map=<project>=/work/project`, GCC ≥ 8, so ESP32 only):
 * the native project cannot live at /work/project, and a sketch whose code expands __FILE__
 * (log_e, assert) otherwise embeds a different string.
 */
export type RefVariant = "plain" | "file-map";

/** Where the reused PlatformIO projects live (CORPUS_PROJECTS: another parent dir, e.g. for a second run). */
export const PROJECTS_ROOT = resolve(process.env.CORPUS_PROJECTS ?? WORK, "corpus-proj");

export function refKey(board: string, files: Array<{ path: string; content: string }>, variant: RefVariant = "plain"): string {
    const cfg = loadConfig();
    const b = cfg.boards.find((x) => x.id === board)!;
    return sha256(JSON.stringify({ packVersion: cfg.packVersion, board, ini: platformioIni(cfg, b), files: [...files].sort((x, y) => (x.path < y.path ? -1 : 1)), ...(variant === "plain" ? {} : { variant }) })).slice(0, 16);
}

export function refDirOf(sketchId: string, board: string, files: Array<{ path: string; content: string }>, variant: RefVariant = "plain"): string {
    const cfg = loadConfig();
    return join(REF_ROOT, cfg.packVersion, board, `${sketchId.replace(/[^A-Za-z0-9_.-]+/g, "_")}.${refKey(board, files, variant)}`);
}

export function cachedRef(sketchId: string, board: string, files: Array<{ path: string; content: string }>, variant: RefVariant = "plain"): NativeRef | null {
    const dir = refDirOf(sketchId, board, files, variant);
    const p = join(dir, "result.json");
    if (!existsSync(p)) return null;
    return { ...(JSON.parse(readFileSync(p, "utf8")) as NativeRef), dir, cached: true };
}

/** A few reused PlatformIO projects per board; `build` waits for a free one. */
export class RefBuilder {
    private free: string[] = [];
    private waiting: Array<(dir: string) => void> = [];
    private pending = new Map<string, Promise<NativeRef>>();

    constructor(readonly board: string, slots: number) {
        for (let i = 0; i < slots; i++) this.free.push(join(PROJECTS_ROOT, `${board}-${i}`));
    }

    private async acquire(): Promise<string> {
        const d = this.free.pop();
        if (d) return d;
        return new Promise((res) => this.waiting.push(res));
    }

    private release(d: string) {
        const w = this.waiting.shift();
        if (w) w(d);
        else this.free.push(d);
    }

    /** The reference build of a sketch (once per builder, cached on disk unless `force`). */
    build(sketchId: string, files: Array<{ path: string; content: string }>, force = false, variant: RefVariant = "plain"): Promise<NativeRef> {
        const key = refDirOf(sketchId, this.board, files, variant);
        let p = this.pending.get(key);
        if (!p) {
            p = this.buildNow(sketchId, files, force, variant);
            this.pending.set(key, p);
        }
        return p;
    }

    private async buildNow(sketchId: string, files: Array<{ path: string; content: string }>, force: boolean, variant: RefVariant): Promise<NativeRef> {
        if (!force) {
            const c = cachedRef(sketchId, this.board, files, variant);
            if (c) return c;
        }
        const proj = await this.acquire();
        try {
            const t = Date.now();
            mkdirSync(proj, { recursive: true });
            writeProject(proj, this.board, files, variant === "file-map" ? [`build_src_flags = -fmacro-prefix-map=${proj}=${loadConfig().virtualRoots.project}`] : []);
            const out = join(proj, ".pio/build", this.board);
            for (const f of OUT_FILES) rmSync(join(out, f), { force: true });
            const r = await pioRun(proj, this.board);
            const dir = refDirOf(sketchId, this.board, files, variant);
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true });
            if (r.ok) for (const f of OUT_FILES) if (existsSync(join(out, f))) copyFileSync(join(out, f), join(dir, f));
            const res: NativeRef = {
                ok: r.ok,
                dir,
                size: pioSize(r.log),
                errors: r.ok ? [] : nativeErrors(r.log, proj, files),
                ...(r.ok ? {} : { logTail: r.log.slice(-6000) }),
                seconds: Math.round((Date.now() - t) / 100) / 10,
                cached: false,
            };
            writeFileSync(join(dir, "result.json"), JSON.stringify({ ...res, dir: undefined, cached: undefined }, null, 1));
            return res;
        } finally {
            this.release(proj);
        }
    }
}
