/**
 * Registry libraries (`lib_deps`) at compile time: resolve → download → library models (with
 * a cached lock), compile lines of library sources, archives, and the framework headers the
 * closure bundle lacks (headerIndex: fetched on the compiler's "No such file or directory" and
 * the translation unit retried).
 */
import { writeArchive } from "./ar";
import { sha1Hex, type PackStore } from "./cache";
import type { BoardManifest, FileRef, HeaderIndex, LibraryEntry } from "./manifest";
import type { RegistryClient } from "./registry/client";
import { libraryFromPackage, type RegistryLibrary } from "./registry/library";
import { resolveLibDeps, type InstalledPackage } from "./registry/resolve";

/** Library compile lines: the project's, without the project's own `-I src`. */
export function libTemplate(tmpl: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < tmpl.length; i++) {
        if (tmpl[i] === "-I" && tmpl[i + 1] === "src") {
            i++;
            continue;
        }
        if (tmpl[i] === "-Isrc") continue;
        out.push(tmpl[i]!);
    }
    return out;
}

/**
 * Extra flags (library.json build.flags, platformio.ini build_flags) in a cc1/cc1plus argv as the
 * driver would place them after the board's own: `-D`/`-U` after the last define, everything
 * else (warnings, -f, -O, -std: the last one wins) before `-o`. `unflags` removes flags.
 */
export function applyFlags(argv: string[], flags: string[], unflags: string[] = []): string[] {
    let out = [...argv];
    for (const u of unflags) {
        if (u.startsWith("-D") || u.startsWith("-U")) {
            const name = u.slice(2);
            out = out.filter((a, i) => !(a === u || (a === u.slice(0, 2) && out[i + 1] === name)));
            out = out.filter((a, i) => !(name && a === name && (out[i - 1] === "-D" || out[i - 1] === "-U")));
        } else out = out.filter((a) => a !== u);
    }
    const defs: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < flags.length; i++) {
        const f = flags[i]!;
        if ((f === "-D" || f === "-U") && i + 1 < flags.length) defs.push(f, flags[++i]!);
        else if (/^-[DU]./.test(f)) defs.push(f.slice(0, 2), f.slice(2));
        else rest.push(f);
    }
    if (defs.length) {
        let last = -1;
        for (let i = 0; i < out.length; i++) if (out[i] === "-D" || out[i] === "-U" || /^-[DU]./.test(out[i]!)) last = out[i]!.length > 2 ? i : i + 1;
        const at = last >= 0 ? last + 1 : Math.max(0, out.indexOf("${SRC}"));
        out.splice(at, 0, ...defs);
    }
    if (rest.length) {
        const o = out.lastIndexOf("-o");
        out.splice(o >= 0 ? o : out.length, 0, ...rest);
    }
    return out;
}

export interface Lock {
    packages: Array<Omit<InstalledPackage, "files"> & { files?: undefined }>;
    warnings: string[];
}

const LOCK_CACHE = "arduino-wasm-registry-v1";
const lockUrl = (key: string) => `https://arduino-wasm.invalid/lock/${key}`;

export async function saveLock(key: string, lock: Lock, useCaches: boolean) {
    if (!useCaches || typeof caches === "undefined") return;
    try {
        const c = await caches.open(LOCK_CACHE);
        await c.put(lockUrl(key), new Response(JSON.stringify(lock), { headers: { "content-type": "application/json" } }));
    } catch {
        /* best effort */
    }
}

export async function loadLock(key: string, useCaches: boolean): Promise<Lock | null> {
    if (!useCaches || typeof caches === "undefined") return null;
    try {
        const c = await caches.open(LOCK_CACHE);
        const r = await c.match(lockUrl(key));
        return r ? ((await r.json()) as Lock) : null;
    } catch {
        return null;
    }
}

/** Installed packages → library models in the libdeps storage (GetLibBuilders order: by dir name). */
export function registryLibraries(m: BoardManifest, packages: InstalledPackage[]): RegistryLibrary[] {
    const reg = m.registry!;
    const sorted = [...packages].sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
    return sorted.map((p, i) =>
        libraryFromPackage(p.files, { name: p.manifest?.name || p.name, version: p.version, owner: p.owner, dirName: p.dirName }, {
            frameworks: [reg.framework],
            platform: reg.platform,
            storage: `${m.fs.cwd}/${reg.libdepsDir}`,
            cliStorage: reg.libdepsDir,
            order: 150000 + i,
        }),
    );
}

export { resolveLibDeps };

/** One source of a registry library to compile. */
export interface LibTu {
    lib: RegistryLibrary;
    /** Source path as on the command line (relative to the project). */
    src: string;
    /** Object path relative to the project. */
    obj: string;
    kind: "cpp" | "c" | "S" | "s";
}

/** `.pio/build/<env>/lib<sha1(path)[:3]>/<dir>`, PlatformIO's library build dir. */
export async function libBuildDir(m: BoardManifest, lib: RegistryLibrary): Promise<string> {
    const h = (await sha1Hex(lib.build.root)).slice(0, 3);
    return `${m.fs.buildDir}/lib${h}/${lib.build.root.slice(lib.build.root.lastIndexOf("/") + 1)}`;
}

export function tuKind(src: string): LibTu["kind"] | null {
    if (/\.c$/.test(src)) return "c";
    if (/\.(cc|cpp|cxx|c\+\+)$/.test(src)) return "cpp";
    if (/\.(S|spp|SPP|sx)$/.test(src)) return "S";
    if (/\.s$/.test(src)) return "s";
    return null;
}

/** SCons StaticLibrary of the library's objects (members by basename, in build order). */
export function libraryArchive(objects: Array<{ path: string; data: Uint8Array }>): Uint8Array {
    return writeArchive(objects.map((o) => ({ name: o.path.slice(o.path.lastIndexOf("/") + 1), data: o.data })));
}

/**
 * Framework headers outside the closure bundle, fetched one by one from the pack's headerIndex.
 */
export class HeaderIndexResolver {
    private index: Promise<{ dirs: string[]; byPath: Map<string, { sha: string; size: number }> }> | null = null;
    constructor(
        private store: PackStore,
        private ref: FileRef,
    ) {}
    private load() {
        if (!this.index) {
            this.index = (async () => {
                const raw = JSON.parse(new TextDecoder().decode(await this.store.get(this.ref))) as HeaderIndex;
                const byPath = new Map<string, { sha: string; size: number }>();
                for (const [d, rel, sha, size] of raw.files) {
                    const p = `${raw.dirs[d]}/${rel}`;
                    if (!byPath.has(p)) byPath.set(p, { sha, size });
                }
                return { dirs: raw.dirs, byPath };
            })();
            this.index.catch(() => (this.index = null));
        }
        return this.index;
    }
    /**
     * The file the compiler would have found for `#include <header>` (in the index's directory
     * order; for `"header"` first next to the including file). Null when the framework lacks it.
     */
    async find(header: string, includer: string | null, quoted: boolean): Promise<{ path: string; data: Uint8Array } | null> {
        const { dirs, byPath } = await this.load();
        const cands: string[] = [];
        if (quoted && includer?.startsWith("/")) cands.push(normAbs(`${includer.slice(0, includer.lastIndexOf("/"))}/${header}`));
        for (const d of dirs) cands.push(normAbs(`${d}/${header}`));
        for (const p of cands) {
            const e = byPath.get(p);
            if (e) return { path: p, data: await this.store.get({ file: `files/${e.sha}.h`, size: e.size, sha256: e.sha }) };
        }
        return null;
    }
}

const normAbs = (p: string) => {
    const parts: string[] = [];
    for (const s of p.split("/")) {
        if (!s || s === ".") continue;
        if (s === "..") parts.pop();
        else parts.push(s);
    }
    return "/" + parts.join("/");
};

/** `X: No such file or directory` lines of a gcc run: the header, the including file and line, and the include's quoting. */
export function missingIncludes(output: string, cwd: string): Array<{ header: string; file: string | null; line: number | null; quoted: boolean }> {
    const out: Array<{ header: string; file: string | null; line: number | null; quoted: boolean }> = [];
    const lines = output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = /^(.+?):(\d+):(?:\d+:)? fatal error: (.+?): No such file or directory$/.exec(lines[i]!);
        if (!m) continue;
        const header = m[3]!;
        const next = lines.slice(i + 1, i + 3).join("\n");
        const quoted = new RegExp(`#\\s*include\\s*"${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(next);
        const f = m[1]!;
        out.push({ header, file: f.startsWith("/") ? f : `${cwd}/${f}`, line: Number(m[2]), quoted });
    }
    return out;
}

export type { RegistryLibrary, LibraryEntry, RegistryClient };
