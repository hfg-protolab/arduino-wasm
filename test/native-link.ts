/**
 * Native `ld` over the same stripped pack files the wasm link used (Node/Bun only): the
 * reference for "the wasm link is byte-identical" in the end-to-end test and the corpus.
 *
 * The directory mirrors the virtual FS (`/opt/...`, `/work/...` under a per-board root). The
 * pack's link files, every library archive and — on lazily linked boards — the FULL framework
 * archives (rebuilt from the symbol index, not the lazily reduced ones) are written once per
 * board and process; per link only the sketch objects are replaced.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, nativeTool, REPO, run } from "../pack/common.ts";
import { writeArchive } from "../src/ar";
import { expandArgs } from "../src/driver";
import type { BoardManifest, LinkIndex } from "../src/manifest";

export function diffCount(a: Uint8Array, b: Uint8Array, skip: (i: number) => boolean = () => false): number {
    let n = Math.abs(a.length - b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i] && !skip(i)) n++;
    return n;
}

const prepared = new Map<string, string>();

/** Root dir of the native link of `m`, with the pack's files in place (once per board and process). */
function boardRoot(pack: string, m: BoardManifest, workDir: string): string {
    const key = `${pack}|${m.id}|${workDir}`;
    const done = prepared.get(key);
    if (done) return done;
    const root = join(workDir, `native-link-${m.id}`);
    const packFile = (file: string) => new Uint8Array(readFileSync(join(pack, file)));
    rmSync(root, { recursive: true, force: true });
    const put = (vp: string, data: Uint8Array) => {
        const p = join(root, vp);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, data);
    };
    for (const f of m.link.files) put(f.path, packFile(f.file));
    for (const l of m.libraries) if (l.archive) put(`${m.fs.cwd}/${l.archive.path}`, packFile(l.archive.file));
    if (m.link.lazy) {
        const index = JSON.parse(new TextDecoder().decode(packFile(m.link.lazy.index.file))) as LinkIndex;
        for (const a of index.archives) {
            const syms = new Map<object, string[]>();
            const members = a.members.map((mm) => {
                const am = { name: mm.n, data: packFile(`files/${mm.h}.o`) };
                syms.set(am, (mm.a ?? []).map((i) => index.strings[i]!));
                return am;
            });
            put(a.path, writeArchive(members, { symbols: (x) => syms.get(x) ?? [] }));
        }
    }
    for (const d of m.fs.mkdirs) mkdirSync(join(root, d), { recursive: true });
    prepared.set(key, root);
    return root;
}

/**
 * The objects of a wasm link in pio's order, relative to the project dir: library objects
 * (lib_archive = no, LDF post-order) first, then the sketch's objects in path order.
 */
export function linkObjects(m: BoardManifest, intermediates: Map<string, Uint8Array>, libraries: string[]): string[] {
    const lib = libraries.flatMap((n) => m.libraries.find((l) => l.name === n)?.objects?.map((o) => o.path) ?? []);
    const src = [...intermediates.keys()].filter((p) => p.startsWith(`${m.fs.cwd}/${m.fs.buildDir}/src/`) && p.endsWith(".o")).map((p) => p.slice(m.fs.cwd.length + 1)).sort();
    return [...lib, ...src];
}

export interface NativeLinkResult {
    elf: Uint8Array;
    /** The native link's root directory (mirrors the virtual FS). */
    root: string;
}

/**
 * Links `objs` (paths relative to the project dir, bytes in `intermediates` by absolute virtual
 * path) with the native ld of the board's PlatformIO toolchain, the manifest's argv and `libs`
 * (library archive paths relative to the project dir).
 */
export function nativeLink(pack: string, m: BoardManifest, intermediates: Map<string, Uint8Array>, objs: string[], libs: string[], workDir = join(REPO, ".build/test-work")): NativeLinkResult {
    const root = boardRoot(pack, m, workDir);
    const cwd = join(root, m.fs.cwd);
    // sketch objects of the previous link must not linger
    rmSync(join(cwd, m.fs.buildDir, "src"), { recursive: true, force: true });
    for (const [p, d] of intermediates) {
        if (!p.endsWith(".o")) continue;
        const f = join(root, p);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, d);
    }
    const elf = `${m.fs.buildDir}/firmware.native.elf`;
    const argv = expandArgs(m.link.ld, { ELF: elf }, { OBJS: objs, LIBS: libs }).map((a) => a.replace(/^(-L|-T)?(\/(?:opt|work)\/)/, (_, pre: string | undefined, p: string) => `${pre ?? ""}${root}${p}`));
    const b = loadConfig().boards.find((x) => x.id === m.id)!;
    mkdirSync(join(cwd, m.fs.buildDir), { recursive: true });
    rmSync(join(cwd, elf), { force: true });
    // The native avr-gcc links with GCC's LTO plugin, which shifts section ids (the Mega's
    // trampoline order); the wasm ld emulates that (toolchains/avr/binutils-2.26-lto-plugin-ids.patch).
    const ld = nativeTool(b, "ld");
    const plugin = b.arch === "avr" ? join(dirname(ld), "../libexec/gcc/avr/7.3.0/liblto_plugin.so") : "";
    const pre = plugin && existsSync(plugin) ? ["-plugin", plugin, `-plugin-opt=${join(dirname(plugin), "lto-wrapper")}`] : [];
    const res = run(ld, [...pre, ...argv], { cwd });
    if (res.code !== 0 || !existsSync(join(cwd, elf))) throw new Error(`native ld failed:\n${res.stderr}`);
    return { elf: new Uint8Array(readFileSync(join(cwd, elf))), root };
}

/**
 * Compares the wasm ELF with the native one. Identical bytes, or — when loose objects without an
 * STT_FILE symbol (crtbegin.o/crtend.o on ESP32) got a file symbol named after the path ld
 * opened, which differs because the native link runs under another root — identical after
 * `--strip-all` and identical symbol lists up to that root. Returns null when equal, else why not.
 */
export function compareWithNative(m: BoardManifest, wasmElf: Uint8Array, native: NativeLinkResult): string | null {
    if (!diffCount(wasmElf, native.elf)) return null;
    const b = loadConfig().boards.find((x) => x.id === m.id)!;
    const dir = native.root;
    writeFileSync(join(dir, "wasm.elf"), wasmElf);
    writeFileSync(join(dir, "native.elf"), native.elf);
    for (const f of ["wasm", "native"]) {
        const r = run(nativeTool(b, "objcopy"), ["--strip-all", join(dir, `${f}.elf`), join(dir, `${f}.stripped.elf`)]);
        if (r.code !== 0) return `objcopy failed: ${r.stderr}`;
    }
    const d = diffCount(new Uint8Array(readFileSync(join(dir, "wasm.stripped.elf"))), new Uint8Array(readFileSync(join(dir, "native.stripped.elf"))));
    if (d) return `${d} bytes differ after --strip-all`;
    const nm = (f: string) => run(nativeTool(b, "nm"), ["-a", join(dir, f)]).stdout.split(dir).join("");
    if (nm("wasm.elf") !== nm("native.elf")) return "symbol tables differ (beyond the root of ld's own file symbols)";
    return null;
}
