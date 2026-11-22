/**
 * Native reference builds with PlatformIO for the end-to-end tests: the same platformio.ini as
 * the AI Hub writes (plus `build_unflags = -flto -fuse-linker-plugin` where the pack builds
 * without LTO), one project per sketch and board under .build/pack-work/ref/<sketch>.<board>.
 *
 *   bun test/reference-build.ts <sketch> <board> [<sketch> <board> ...]
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPioarduino, loadConfig, PIO, pioEnv, REPO, run, sha256, WORK } from "../pack/common.ts";
import { platformioIni } from "../pack/probe.ts";

/** The files of a test sketch: test/sketches/<name>.ino or every file of test/sketches/<name>/. */
export function sketchFiles(sketch: string): Array<{ path: string; content: string }> {
    const dir = join(REPO, "test/sketches", sketch);
    if (existsSync(dir) && statSync(dir).isDirectory()) return readdirSync(dir).sort().map((f) => ({ path: f, content: readFileSync(join(dir, f), "utf8") }));
    return [{ path: `${sketch}.ino`, content: readFileSync(join(REPO, "test/sketches", `${sketch}.ino`), "utf8") }];
}

export const refDir = (sketch: string, board: string, extraIni: string[] = []) => join(WORK, "ref", `${sketch}.${board}${extraIni.length ? `.${sha256(extraIni.join("\n")).slice(0, 8)}` : ""}`);

/**
 * (Re)writes a PlatformIO project: platformio.ini (plus `extraIni` lines in the env section) and
 * src/ with exactly `files` (a reused project keeps .pio/).
 */
export function writeProject(dir: string, board: string, files: Array<{ path: string; content: string }>, extraIni: string[] = []) {
    const cfg = loadConfig();
    const b = cfg.boards.find((x) => x.id === board);
    if (!b) throw new Error(`board ${board}`);
    rmSync(join(dir, "src"), { recursive: true, force: true });
    for (const f of files) {
        const p = join(dir, "src", f.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.content);
    }
    writeFileSync(join(dir, "platformio.ini"), platformioIni(cfg, b) + (extraIni.length ? `${extraIni.join("\n")}\n` : ""));
}

/**
 * `pio run -v` in a project written by writeProject; the build output is in .pio/build/<board>.
 * Output goes straight to <dir>/build.log (not a pipe: a busy event loop must not stall pio).
 */
export async function pioRun(dir: string, board: string): Promise<{ ok: boolean; log: string }> {
    const logPath = join(dir, "build.log");
    const fd = openSync(logPath, "w");
    try {
        const code = await new Promise<number>((res, rej) => {
            const p = spawn(PIO, pioRunArgs(board), { cwd: dir, stdio: ["ignore", fd, fd], env: pioEnv(loadConfig()) });
            p.on("error", rej);
            p.on("close", (c) => res(c ?? 1));
        });
        return { ok: code === 0, log: readFileSync(logPath, "utf8") };
    } finally {
        closeSync(fd);
    }
}

/**
 * `pio run -v`, except on pioarduino boards: its verbose mode crashes after the link (SCons
 * TypeError printing the unsubstituted elf2image action), so firmware.bin would be missing.
 */
export function pioRunArgs(board: string): string[] {
    const b = loadConfig().boards.find((x) => x.id === board);
    return b && isPioarduino(b.platform) ? ["run", "-e", board] : ["run", "-v", "-e", board];
}

export function referenceBuild(sketch: string, board: string, force = false, extraIni: string[] = []): string {
    const dir = refDir(sketch, board, extraIni);
    const out = join(dir, ".pio/build", board);
    if (!force && existsSync(join(out, "firmware.elf"))) return out;
    rmSync(dir, { recursive: true, force: true });
    writeProject(dir, board, sketchFiles(sketch), extraIni);
    const r = run(PIO, pioRunArgs(board), { cwd: dir, env: pioEnv(loadConfig()) });
    writeFileSync(join(dir, "build.log"), r.stdout + r.stderr);
    if (r.code !== 0) throw new Error(`pio run ${sketch}.${board} failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
    return out;
}

if (import.meta.main) {
    const a = process.argv.slice(2);
    for (let i = 0; i + 1 < a.length; i += 2) {
        const t = Date.now();
        referenceBuild(a[i]!, a[i + 1]!, true);
        console.log(`${a[i]}.${a[i + 1]} ok (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
}
