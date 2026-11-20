/**
 * Step 1 of the pack builder: native reference build per board.
 *
 * Installs the allowed libraries (like the AI Hub image: `pio pkg install --global --storage-dir
 * <libs>/<dir>`), writes one PlatformIO project per board whose sources include every header of
 * every framework library and every allowed library (one TU per library, so a header that
 * #errors on a chip only drops that library), and runs `pio run -v`. The log holds every compile
 * line (flags for the sketch, .c files), the archive of every library, the link line and the
 * "Dependency Graph". Libraries whose probe TU does not compile are dropped and the build retried.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { type BoardConfig, LIBS, pioEnv, type PackConfig, PIO, PKG, pool, run, runAsync, shellSplit, toolchainPackage, WORK } from "./common.ts";

export interface LibraryDir {
    /** Library directory name (= PlatformIO library name for framework libraries). */
    dirName: string;
    path: string;
    origin: "framework" | "allowed";
}

export const libsRoot = () => LIBS;
export const projectDir = (board: string) => join(WORK, "probe", board);
export const probeLog = (board: string) => join(WORK, "probe", `${board}.log`);

export function frameworkPackage(arch: string): string {
    if (arch === "avr") return "framework-arduino-avr";
    return arch === "esp8266" ? "framework-arduinoespressif8266" : "framework-arduinoespressif32";
}

export function installLibraries(cfg: PackConfig) {
    for (const l of cfg.libraries) {
        const dir = join(libsRoot(), l.dir);
        mkdirSync(dir, { recursive: true });
        const r = run(PIO, ["pkg", "install", "--global", "--storage-dir", dir, "--library", l.spec]);
        if (r.code !== 0) throw new Error(`install ${l.spec}: ${r.stdout}${r.stderr}`);
    }
}

export function libraryDirs(cfg: PackConfig, b: BoardConfig): LibraryDir[] {
    const out: LibraryDir[] = [];
    const fw = join(PKG, frameworkPackage(b.arch), "libraries");
    for (const n of readdirSync(fw).sort()) if (statSync(join(fw, n)).isDirectory()) out.push({ dirName: n, path: join(fw, n), origin: "framework" });
    for (const d of ["all", b.arch]) {
        const root = join(libsRoot(), d);
        if (!existsSync(root)) continue;
        for (const n of readdirSync(root).sort()) if (statSync(join(root, n)).isDirectory()) out.push({ dirName: n, path: join(root, n), origin: "allowed" });
    }
    return out;
}

/** Top-level public headers of a library (src/ if present, else the root). */
export function topHeaders(lib: string): string[] {
    const src = existsSync(join(lib, "src")) ? join(lib, "src") : lib;
    return readdirSync(src)
        .filter((f) => /\.(h|hpp)$/.test(f))
        .sort();
}

export function platformioIni(cfg: PackConfig, b: BoardConfig): string {
    return [
        "[platformio]",
        "src_dir = src",
        "",
        `[env:${b.id}]`,
        `platform = ${b.platform}`,
        `board = ${b.board}`,
        `framework = ${b.framework}`,
        `lib_extra_dirs = ${join(libsRoot(), "all")}, ${join(libsRoot(), b.arch)}`,
        "lib_ldf_mode = chain",
        ...(b.noLto ? ["build_unflags = -flto -fuse-linker-plugin"] : []),
        "",
    ].join("\n");
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");

/** One probe TU per (library, header); a header that does not compile alone on this board is left out. */
interface ProbeTu {
    lib: LibraryDir;
    header: string;
    file: string;
}

/** Runs the probe build; returns the libraries that compiled (at least one header). */
export async function probe(cfg: PackConfig, b: BoardConfig, opts: { force?: boolean } = {}): Promise<{ log: string; libs: LibraryDir[]; dropped: string[] }> {
    const dir = projectDir(b.id);
    const logPath = probeLog(b.id);
    const libs = libraryDirs(cfg, b);
    const statePath = join(dir, "probe-state.json");
    if (!opts.force && existsSync(logPath) && existsSync(statePath)) {
        const st = JSON.parse(readFileSync(statePath, "utf8"));
        return { log: readFileSync(logPath, "utf8"), libs: libs.filter((l) => !st.dropped.includes(l.dirName)), dropped: st.dropped };
    }
    let tus: ProbeTu[] = libs.flatMap((lib) => topHeaders(lib.path).map((header) => ({ lib, header, file: `probe_${safe(lib.dirName)}__${safe(header)}.cpp` })));
    const droppedHeaders: string[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
        rmSync(join(dir, "src"), { recursive: true, force: true });
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "platformio.ini"), platformioIni(cfg, b));
        writeFileSync(join(dir, "src/main.ino"), "void setup() {\n}\n\nvoid loop() {\n}\n");
        writeFileSync(join(dir, "src/probe_c.c"), "int probe_c(int x) { return x + 1; }\n");
        for (const t of tus) writeFileSync(join(dir, "src", t.file), `#include <Arduino.h>\n#include <${t.header}>\n`);
        // a retry keeps .pio: SCons rebuilds only what changed (a framework build is minutes on 3.x)
        if (attempt === 0) rmSync(join(dir, ".pio"), { recursive: true, force: true });
        console.log(`[${b.id}] pio run -v (attempt ${attempt + 1}, ${tus.length} probe TUs)`);
        const r = run(PIO, ["run", "-v", "-e", b.id], { cwd: dir, env: pioEnv(cfg) });
        const log = r.stdout + r.stderr;
        writeFileSync(logPath, log);
        const failed = /\*\*\* \[\.pio\/build\/[^/]+\/src\/probe_/.test(log);
        // pioarduino links every library object (lib_archive = no): a library that cannot link in
        // the board's default configuration (Zigbee without ZigbeeMode, …) fails the whole link.
        // Natively a sketch using it fails the same way; leave the library out of the pack.
        if (!failed && /\*\*\* \[\.pio\/build\/[^/]+\/firmware\.elf\] Error/.test(log)) {
            const bad = new Set<string>();
            for (const m of log.matchAll(/\.pio\/build\/[^/]+\/lib[0-9a-f]+\/([^/\n]+)\/[^\n]*?\.o: in function/g)) bad.add(m[1]!);
            const before = tus.length;
            tus = tus.filter((t) => !bad.has(t.lib.dirName));
            if (!bad.size || tus.length === before) throw new Error(`[${b.id}] probe link failed:\n${log.slice(-4000)}`);
            for (const l of bad) droppedHeaders.push(`${l}/* (does not link)`);
            console.log(`[${b.id}] dropping libraries that do not link: ${[...bad].join(", ")}`);
            continue;
        }
        if (!failed) {
            if (!/firmware\.elf/.test(log)) throw new Error(`[${b.id}] probe build did not reach the link:\n${log.slice(-4000)}`);
            const kept = new Set(tus.map((t) => t.lib.dirName));
            const dropped = libs.filter((l) => !kept.has(l.dirName)).map((l) => l.dirName);
            writeFileSync(statePath, JSON.stringify({ dropped, droppedHeaders }, null, 1));
            return { log, libs: libs.filter((l) => kept.has(l.dirName)), dropped };
        }
        // Syntax-check every probe TU natively with the flags pio used for one of them.
        const line = log.split("\n").find((l) => / -o \.pio\/build\/[^/]+\/src\/probe_\w+\.cpp\.o -c /.test(l));
        if (!line) throw new Error(`[${b.id}] no probe compile line:\n${log.slice(-3000)}`);
        const argv = shellSplit(line);
        const oi = argv.indexOf("-o");
        argv.splice(oi, 2);
        argv.pop(); // the source
        const cc = join(PKG, toolchainPackage(b), "bin", argv[0]!);
        const ok = await pool(tus, availableParallelism(), async (t) => (await runAsync(cc, [...argv.slice(1).filter((a) => a !== "-c"), "-fsyntax-only", join("src", t.file)], { cwd: dir })).code === 0);
        const bad = tus.filter((_, i) => !ok[i]);
        if (!bad.length) throw new Error(`[${b.id}] probe failed but every TU compiles alone:\n${log.slice(-3000)}`);
        for (const t of bad) droppedHeaders.push(`${t.lib.dirName}/${t.header}`);
        console.log(`[${b.id}] dropping headers: ${bad.map((t) => `${t.lib.dirName}/${t.header}`).join(", ")}`);
        tus = tus.filter((_, i) => ok[i]);
    }
    throw new Error(`[${b.id}] probe kept failing`);
}
