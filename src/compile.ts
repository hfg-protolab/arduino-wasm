/**
 * compileFirmware: sketch files → flashable images, entirely on the client.
 *
 *   .ino → .cpp (ino.ts) → libraries (ldf.ts) → cc1plus/cc1 + as per TU (driver.ts, cached per
 *   TU) → lazy link: resolve the members ld will load (resolve.ts), fetch only those, write
 *   mini archives (ar.ts) → ld → Intel HEX or ESP32 app image (hex.ts / esp-image.ts) + size.
 *
 * Browser-safe. Tools run inline by default; pass `executor` (worker pool, worker.ts) to run
 * translation units in parallel.
 */
import { readArchive, writeArchive, type ArMember } from "./ar";
import { readBundle } from "./bundle";
import { ObjectCache, PackStore, PersistentObjectCache, sha256Hex, type StoreOptions } from "./cache";
import { mapPath, parseDiagnostics, type DiagnosticContext } from "./diagnostics";
import { applyFlags, HeaderIndexResolver, libBuildDir, libraryArchive, libTemplate, loadLock, missingIncludes, registryLibraries, saveLock, tuKind, type LibTu } from "./libbuild";
import { registryClient, RegistryUnreachableError, suggestForHeader, type RegistryClient } from "./registry/client";
import { parsePlatformioIni, type PlatformioIni } from "./registry/ini";
import { splitFlags, type RegistryLibrary } from "./registry/library";
import { itemsInList } from "./registry/manifest";
import { LibraryProblemError, problemMessage, resolveLibDeps, unpackPackage, type InstalledPackage } from "./registry/resolve";
import { expandArgs, loadTool, runTool, tagFileset, type LoadedTool, type RunOptions, type RunResult } from "./driver";
import { ElfFile } from "./elf";
import { elfToEspImage } from "./esp-image";
import { elfToEsp8266Image } from "./esp8266-image";
import { elfToIntelHex } from "./hex";
import { inoToCpp, PreprocessUnsupportedError } from "./ino";
import { scanIncludes, selectLibraries } from "./ldf";
import type { BoardManifest, FileRef, IndexMember, LibraryEntry, LinkIndex, PackIndex, ToolName } from "./manifest";
import { resolve, type ArchiveIndex, type ResolveInput } from "./resolve";
import { formatSizeReport, sizeProblems, sizeReport } from "./size";
import { elfSymbols, type ObjSymbol } from "./symbols";
import type { CompileProgress, CompileRequest, CompileResponse, CompileStats, Diagnostic, FirmwareImage, LibraryProblem, MissingHeader, SourceFile } from "./types";

/** Runs one tool invocation (inline, or in a worker of a pool). */
export interface ToolExecutor {
    run(tool: LoadedTool, argv: string[], opts: RunOptions): Promise<RunResult>;
}

export const inlineExecutor: ToolExecutor = { run: runTool };

export interface CompileOptions extends StoreOptions {
    /** Base URL of the pack version (the directory with index.json). */
    packBaseUrl: string;
    onProgress?: (p: CompileProgress) => void;
    /** false: no object cache (every TU is compiled). Cache Storage: `cacheStorage`. */
    cache?: boolean;
    /** Use the precompiled Arduino.h when the pack has one (default true). */
    usePch?: boolean;
    /** Runs translation units in parallel when a sketch has more than one (worker pool, pool.ts). */
    executor?: ToolExecutor;
    /** Keep the intermediate files (objects, ELF, mini archives) in the response (tests). */
    keepIntermediates?: boolean;
    /**
     * Host route to the PlatformIO registry (e.g. "/firmware-libs/"): metadata from
     * `${registryBase}api/v3/<path>?<query>`, packages from `${registryBase}dl/<sha256>?url=<download_url>`.
     * Unset: the registry directly (Node; browsers cannot follow its download redirect).
     */
    registryBase?: string;
    /** fetch for the registry (tests); default: the global fetch (`fetch` serves the pack). */
    registryFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface CompileResult extends CompileResponse {
    /** With `keepIntermediates`: absolute virtual path → bytes of objects, archives and the ELF. */
    intermediates?: Map<string, Uint8Array>;
    /** With `keepIntermediates`: `${OBJS}` and `${LIBS}` of the link (paths relative to the project). */
    link?: { objects: string[]; archives: string[] };
}

const FILE_RE = /^[A-Za-z0-9_\-.][A-Za-z0-9_\-. /]*\.(ino|pde|cpp|c|h|hpp)$/;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

class Compiler {
    readonly store: PackStore;
    private manifests = new Map<string, Promise<BoardManifest>>();
    private tools = new Map<string, Promise<LoadedTool>>();
    private headerSets = new Map<string, Promise<Map<string, Uint8Array>>>();
    private linkIndex = new Map<string, Promise<{ index: LinkIndex; base: Map<string, Uint8Array> }>>();
    readonly objects = new ObjectCache();
    private persistentCache: PersistentObjectCache | null = null;
    private resolvers = new Map<string, HeaderIndexResolver>();
    private extras = new Map<string, { files: Map<string, Uint8Array>; add(path: string, data: Uint8Array): void }>();
    private locks = new Map<string, Promise<{ packages: InstalledPackage[]; warnings: string[] }>>();

    persistent(opts: { cacheStorage?: boolean }): PersistentObjectCache {
        return (this.persistentCache ??= new PersistentObjectCache(this.objects, opts));
    }

    headerResolver(m: BoardManifest): HeaderIndexResolver {
        let r = this.resolvers.get(m.headerIndex!.sha256);
        if (!r) this.resolvers.set(m.headerIndex!.sha256, (r = new HeaderIndexResolver(this.store, m.headerIndex!)));
        return r;
    }

    /** Framework headers fetched on demand (headerIndex), per board; a new file set per addition (worker caches). */
    extraHeaders(m: BoardManifest) {
        let x = this.extras.get(m.id);
        if (!x) {
            let n = 0;
            const box = {
                files: new Map<string, Uint8Array>(),
                add(path: string, data: Uint8Array) {
                    const next = new Map(box.files);
                    next.set(path, data);
                    tagFileset(next, `extra:${m.id}:${++n}`);
                    box.files = next;
                },
            };
            tagFileset(box.files, `extra:${m.id}:0`);
            this.extras.set(m.id, (x = box));
        }
        return x;
    }

    /** lib_deps → installed packages; once per session, a lock in Cache Storage for when the registry is unreachable. */
    resolveLocked(key: string, libDeps: string[], m: BoardManifest, client: RegistryClient, useCaches: boolean, onDownload: (label: string, size: number) => void, onBytes: (n: number) => void) {
        let p = this.locks.get(key);
        if (!p) {
            p = (async () => {
                try {
                    const r = await resolveLibDeps(libDeps, { client, platform: m.registry!.platform, frameworks: [m.registry!.framework], builtinNames: m.registry!.builtinNames, packLibraries: m.libraries, onDownload, onBytes });
                    void saveLock(key, { packages: r.packages.map(({ files: _f, ...rest }) => ({ ...rest, files: undefined })), warnings: r.warnings }, useCaches);
                    return r;
                } catch (e) {
                    if (!(e instanceof RegistryUnreachableError)) throw e;
                    const lock = await loadLock(key, useCaches);
                    if (!lock) throw e;
                    const packages: InstalledPackage[] = [];
                    for (const lp of lock.packages) {
                        onDownload(lp.name, lp.file.size);
                        const { files } = await unpackPackage(await client.tarball(lp.file, onBytes));
                        packages.push({ ...lp, files });
                    }
                    return { packages, warnings: lock.warnings };
                }
            })();
            p.catch(() => this.locks.delete(key));
            this.locks.set(key, p);
        }
        return p;
    }

    constructor(readonly baseUrl: string, storeOpts: StoreOptions) {
        this.store = new PackStore(baseUrl, storeOpts);
    }

    manifest(board: string): Promise<BoardManifest> {
        let p = this.manifests.get(board);
        if (!p) {
            p = (async () => {
                const idx = await this.store.json<PackIndex>("index.json");
                const path = idx.boards[board];
                if (!path) throw new UnknownBoardError(board, Object.keys(idx.boards));
                return this.store.json<BoardManifest>(path);
            })();
            p.catch(() => this.manifests.delete(board));
            this.manifests.set(board, p);
        }
        return p;
    }

    tool(m: BoardManifest, name: ToolName): Promise<LoadedTool> {
        const ref = m.tools[name];
        let p = this.tools.get(ref.wasm.sha256);
        if (!p) {
            p = (async () => {
                const [js, mod] = await Promise.all([this.store.get(ref.js), this.store.wasm(ref.wasm)]);
                const t = await loadTool(name, new TextDecoder().decode(js), mod);
                t.id = ref.wasm.sha256;
                return t;
            })();
            p.catch(() => this.tools.delete(ref.wasm.sha256));
            this.tools.set(ref.wasm.sha256, p);
        }
        return p;
    }

    headers(m: BoardManifest): Promise<Map<string, Uint8Array>> {
        const key = m.headers.map((h) => h.sha256).join(",");
        let p = this.headerSets.get(key);
        if (!p) {
            p = (async () => {
                const map = new Map<string, Uint8Array>();
                const blobs = await Promise.all(m.headers.map((h) => this.store.get(h)));
                for (const b of blobs) for (const e of readBundle(b)) map.set(e.path, e.data);
                tagFileset(map, `headers:${key}`);
                return map;
            })();
            p.catch(() => this.headerSets.delete(key));
            this.headerSets.set(key, p);
        }
        return p;
    }

    lazy(m: BoardManifest) {
        const lz = m.link.lazy!;
        let p = this.linkIndex.get(lz.index.sha256);
        if (!p) {
            p = (async () => {
                const [idx, base] = await Promise.all([this.store.get(lz.index), this.store.get(lz.base)]);
                const index = JSON.parse(new TextDecoder().decode(idx)) as LinkIndex;
                // pioarduino packs have no library archives on the link line: archives of lib_deps
                // libraries (library.json libArchive) go where PlatformIO puts $LIBS, first in the group
                if (!index.inputs.some((x) => x.kind === "libs")) {
                    const g = index.inputs.findIndex((x) => x.kind === "groupStart");
                    index.inputs.splice(g >= 0 ? g + 1 : index.inputs.length, 0, { kind: "libs" });
                }
                const map = new Map<string, Uint8Array>();
                for (const e of readBundle(base)) map.set(e.path, e.data);
                return { index, base: map };
            })();
            p.catch(() => this.linkIndex.delete(lz.index.sha256));
            this.linkIndex.set(lz.index.sha256, p);
        }
        return p;
    }
}

export class UnknownBoardError extends Error {
    constructor(board: string, known: string[]) {
        super(`unknown board "${board}" (this pack has: ${known.join(", ")})`);
    }
}

const compilers = new Map<string, Compiler>();
function compilerFor(opts: CompileOptions): Compiler {
    const key = opts.packBaseUrl;
    let c = compilers.get(key);
    if (!c) {
        c = new Compiler(opts.packBaseUrl, { fetch: opts.fetch, cacheStorage: opts.cacheStorage });
        compilers.set(key, c);
    }
    return c;
}

/** Drops the in-memory state (modules, files, objects) of every pack (tests, benchmarks). */
export function resetCompilers() {
    compilers.clear();
}

/**
 * Progress over a known total of bytes. Bytes count only in the download phase: compile and
 * link count steps, so a file that is still arriving once compiling started (a library archive,
 * a lazily linked archive member) must not push their `loaded` past `total`.
 */
function progressTracker(onProgress: CompileOptions["onProgress"]) {
    let loaded = 0;
    let total = 0;
    let phase: CompileProgress["phase"] = "download";
    let label: string | undefined;
    const emit = () => onProgress?.({ phase, loaded, total, ...(label ? { label } : {}) });
    return {
        label(l: string | undefined) {
            if (l === label) return;
            label = l;
            emit();
        },
        expect(n: number) {
            if (phase !== "download") return;
            total += n;
            emit();
        },
        bytes: (n: number) => {
            if (phase !== "download") return;
            loaded += n;
            emit();
        },
        phase(p: CompileProgress["phase"], l = 0, t = 0) {
            phase = p;
            loaded = l;
            total = t;
            emit();
        },
    };
}

/**
 * Count every file of `refs` that has not fully loaded yet into the progress total, and follow
 * its bytes — including files another call (a prewarm) is already downloading, whose bytes so
 * far are reported at once. Files are de-duplicated (a ref can appear twice).
 */
function expectDownloads(store: PackStore, refs: FileRef[], pr: ReturnType<typeof progressTracker>) {
    const pending = [...new Map(refs.filter((r) => !store.has(r)).map((r) => [r.sha256, r])).values()];
    pr.expect(pending.reduce((s, r) => s + r.size, 0));
    for (const r of pending) store.watch(r, pr.bytes);
}

/** Download the pack of `board` and compile the tools, without compiling anything. */
export async function prewarm(board: string, opts: CompileOptions): Promise<void> {
    const c = compilerFor(opts);
    const m = await c.manifest(board);
    const pr = progressTracker(opts.onProgress);
    const refs: FileRef[] = [...(["cc1plus", "as", "ld"] as ToolName[]).flatMap((t) => [m.tools[t].js, m.tools[t].wasm]), ...m.headers, ...m.link.files];
    if (m.pch && opts.usePch !== false) refs.push(m.pch.gch);
    if (m.link.lazy) refs.push(m.link.lazy.index, m.link.lazy.base);
    if (m.output.kind === "esp-image") refs.push(...m.output.images);
    if (m.output.kind === "esp8266-image") refs.push(m.output.eboot);
    expectDownloads(c.store, refs, pr);
    await Promise.all([
        ...(["cc1plus", "as", "ld"] as ToolName[]).map((t) => c.tool(m, t)),
        c.headers(m),
        ...m.link.files.map((f) => c.store.get(f)),
        ...(m.pch && opts.usePch !== false ? [c.store.get(m.pch.gch)] : []),
        ...(m.link.lazy ? [c.lazy(m)] : []),
        ...(m.output.kind === "esp-image" ? m.output.images.map((i) => c.store.get(i)) : []),
        ...(m.output.kind === "esp8266-image" ? [c.store.get(m.output.eboot)] : []),
    ]);
    pr.phase("done", 1, 1);
}

interface Tu {
    /** Path relative to src/ ("main.ino.cpp", "lib/x.cpp"). */
    path: string;
    lang: "cpp" | "c";
    source: string;
    pch: boolean;
}

export async function compileFirmware(request: CompileRequest, opts: CompileOptions): Promise<CompileResult> {
    const t0 = now();
    const log: string[] = [];
    const c = compilerFor(opts);
    const downloadedBefore = c.store.downloaded;
    const stats: CompileStats = { downloadedBytes: 0, phases: {}, compiled: 0, cached: 0, libraries: [] };
    const extraWarnings: Diagnostic[] = [];
    let regClient: RegistryClient | null = null;
    const regBefore = () => regClient?.downloaded ?? 0;
    let regDownloadedBefore = 0;
    const fail = (errors: Diagnostic[], warnings: Diagnostic[] = [], extra: Partial<CompileResult> = {}): CompileResult => {
        stats.downloadedBytes = c.store.downloaded - downloadedBefore + (regClient ? regClient.downloaded - regDownloadedBefore : 0);
        return { ok: false, board: request.board, errors, warnings: [...extraWarnings, ...warnings], files: [], log: log.join("\n"), durationMs: Math.round(now() - t0), stats, ...extra };
    };
    const err = (message: string): Diagnostic => ({ file: null, line: null, column: null, message });
    const failProblem = (problem: LibraryProblem) => fail([err(problemMessage(problem))], [], { problem });

    let m: BoardManifest;
    try {
        m = await c.manifest(request.board);
    } catch (e) {
        return fail([err((e as Error).message)]);
    }

    // ---- request → project files (+ platformio.ini)
    const own = new Map<string, string>(); // "src/<p>" → caller path
    const files: SourceFile[] = [];
    let ini: PlatformioIni | null = null;
    let iniPath = "platformio.ini";
    for (const f of request.files) {
        const top = f.path.replace(/^\.\//, "");
        if (top === "platformio.ini") {
            if (ini) return fail([err(`file "${f.path}" is there twice`)]);
            ini = parsePlatformioIni(f.content);
            iniPath = f.path;
            continue;
        }
        const p = top.replace(/^src\//, "");
        if (!FILE_RE.test(p) || p.split("/").some((s) => s === "." || s === "..")) return fail([err(`file "${f.path}": only .ino, .pde, .cpp, .c, .h and .hpp files with a relative path`)]);
        if (own.has(`src/${p}`)) return fail([err(`file "${f.path}" is there twice`)]);
        own.set(`src/${p}`, f.path);
        files.push({ path: p, content: f.content });
    }
    const libDeps = ini?.env.libDeps ?? [];
    const buildFlags = ini ? splitFlags(ini.env.buildFlags) : [];
    if (ini) {
        for (const e of ini.errors) extraWarnings.push({ file: iniPath, line: e.line, column: null, message: e.message });
        if (ini.env.unsupported.length) extraWarnings.push({ file: iniPath, line: null, column: null, message: `ignored (not supported in the browser): ${ini.env.unsupported.join(", ")}` });
        const ignoredFlags = buildFlags.filter((f) => !/^-[DU]/.test(f));
        if (ignoredFlags.length) extraWarnings.push({ file: iniPath, line: null, column: null, message: `build_flags: only -D/-U are applied (to the sketch and lib_deps libraries; the precompiled core and pack libraries are not rebuilt); ignored: ${ignoredFlags.join(" ")}` });
    }
    const projectFlags = buildFlags.filter((f, i) => /^-[DU]/.test(f) || /^-[DU]$/.test(buildFlags[i - 1] ?? ""));
    const tus: Tu[] = [];
    let mainIno: string | null = null;
    try {
        const ino = inoToCpp(files, { srcDir: m.fs.srcDir });
        if (ino) {
            const rel = ino.path.slice(m.fs.srcDir.length + 1);
            mainIno = own.get(`src/${ino.mainIno.slice(m.fs.srcDir.length + 1)}`) ?? null;
            tus.push({ path: rel, lang: "cpp", source: ino.cpp, pch: true });
        }
    } catch (e) {
        if (e instanceof PreprocessUnsupportedError) return fail([err(`${e.message}${e.line ? ` (line ${e.line})` : ""}`)]);
        throw e;
    }
    for (const f of files) {
        if (/\.(cpp)$/.test(f.path)) tus.push({ path: f.path, lang: "cpp", source: f.content, pch: false });
        else if (/\.c$/.test(f.path)) tus.push({ path: f.path, lang: "c", source: f.content, pch: false });
    }
    if (!tus.length) return fail([err("files need at least one .ino, .cpp or .c file")]);
    // PlatformIO links the objects in source path order.
    tus.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const diagCtx: DiagnosticContext = {
        cwd: m.fs.cwd,
        paths: own,
        mainIno,
        strip: [/^\/opt\/pio\/packages\//, /^\/opt\/pio-libs\/[^/]+\//],
    };

    const pr = progressTracker(opts.onProgress);
    const tDl = now();

    // ---- registry libraries (lib_deps): resolve, download
    let regLibs: RegistryLibrary[] = [];
    let installed: InstalledPackage[] = [];
    if (libDeps.length) {
        if (!m.registry) return failProblem({ kind: "libUnsupported", spec: libDeps[0]!, reason: `this pack (${m.packVersion}) cannot build registry libraries` });
        regClient = registryClient({ registryBase: opts.registryBase, fetch: opts.registryFetch, cacheStorage: opts.cacheStorage });
        regDownloadedBefore = regBefore();
        const lockKey = await sha256Hex(["lock-v1", m.registry.platform, m.registry.framework, ...libDeps]);
        try {
            const r = await c.resolveLocked(lockKey, libDeps, m, regClient, opts.cacheStorage !== false, (label, size) => {
                pr.label(label);
                pr.expect(size);
            }, pr.bytes);
            installed = r.packages;
            for (const w of r.warnings) extraWarnings.push({ file: iniPath, line: null, column: null, message: w });
            pr.label(undefined);
        } catch (e) {
            if (e instanceof LibraryProblemError) return failProblem(e.problem);
            if (e instanceof RegistryUnreachableError) return failProblem({ kind: "registryUnreachable" });
            return fail([err(`library download failed: ${(e as Error).message}`)]);
        }
        regLibs = registryLibraries(m, installed);
        for (const l of regLibs) {
            const pkg = installed.find((p) => `${m.fs.cwd}/${m.registry!.libdepsDir}/${p.dirName}` === l.build.root)!;
            if (l.incompatible && pkg.direct) return failProblem({ kind: "libIncompatible", spec: pkg.requestedBy, platform: m.registry.platform });
        }
        regLibs = regLibs.filter((l) => !l.incompatible);
    }
    const pkgOf = (l: RegistryLibrary) => installed.find((p) => `${m.fs.cwd}/${m.registry!.libdepsDir}/${p.dirName}` === l.build.root)!;

    // ---- libraries (LDF over the pack's and the registry's)
    const projectForLdf: SourceFile[] = [...tus.map((t) => ({ path: t.path, content: t.source })), ...files.filter((f) => /\.(h|hpp)$/.test(f.path))];
    const allLibs = regLibs.length ? [...m.libraries, ...regLibs.map((l) => l.entry)] : m.libraries;
    const ldf = selectLibraries(projectForLdf, allLibs, { libDeps });
    stats.libraries = ldf.libraries.map((l) => l.name);
    const usedReg = ldf.libraries.map((e) => regLibs.find((l) => l.entry === e)).filter((x): x is RegistryLibrary => !!x);
    for (const l of usedReg) if (l.unsupported) return failProblem({ kind: "libUnsupported", spec: pkgOf(l).requestedBy, reason: l.unsupported });
    // lib_archive: platformio.ini's wins over library.json's (getraw); pioarduino writes
    // `lib_archive = False` into the project config itself when the ini has none
    const iniArchive = ini?.env.libArchive !== undefined ? ini.env.libArchive === "true" : undefined;
    const regArchive = (l: RegistryLibrary) => iniArchive ?? (m.registry!.libArchive ? (l.build.libArchive ?? true) : false);
    const libArchives = ldf.libraries.filter((l): l is LibraryEntry & { archive: NonNullable<LibraryEntry["archive"]> } => !!l.archive);
    if (usedReg.length) stats.registry = { libraries: usedReg.map((l) => `${l.entry.name}@${l.entry.version}`), compiled: 0, cached: 0 };

    // registry library translation units
    const libTus: Array<LibTu & { index: number }> = [];
    for (const l of usedReg) {
        const bd = await libBuildDir(m, l);
        for (const s of l.build.sources) {
            const kind = tuKind(s);
            if (!kind) return failProblem({ kind: "libUnsupported", spec: pkgOf(l).requestedBy, reason: `source ${s}: assembler dialect not supported` });
            if ((kind === "S" || kind === "s") && !m.compileAsm) return failProblem({ kind: "libUnsupported", spec: pkgOf(l).requestedBy, reason: `assembler source ${s} (this pack has no assembler lines)` });
            libTus.push({ lib: l, src: `${l.build.cliRoot}/${l.build.srcDir ? `${l.build.srcDir}/` : ""}${s}`, obj: `${bd}/${s}.o`, kind, index: libTus.length });
        }
    }

    // ---- downloads
    const usePch = !!m.pch && opts.usePch !== false && tus.some((t) => t.pch);
    const anyCpp = tus.some((t) => t.lang === "cpp") || libTus.some((t) => t.kind === "cpp");
    const anyC = tus.some((t) => t.lang === "c") || libTus.some((t) => t.kind === "c" || t.kind === "S");
    const needTools: ToolName[] = ["as", "ld", ...(anyCpp ? (["cc1plus"] as const) : []), ...(anyC ? (["cc1"] as const) : [])];
    const libObjects = ldf.libraries.flatMap((l) => l.objects ?? []);
    const refs: FileRef[] = [...needTools.flatMap((t) => [m.tools[t].js, m.tools[t].wasm]), ...m.headers, ...m.link.files, ...libArchives.map((l) => l.archive), ...libObjects];
    if (usePch) refs.push(m.pch!.gch);
    if (m.link.lazy) refs.push(m.link.lazy.index, m.link.lazy.base);
    if (m.output.kind === "esp-image") refs.push(...m.output.images);
    if (m.output.kind === "esp8266-image") refs.push(m.output.eboot);
    expectDownloads(c.store, refs, pr);
    let toolsP: Record<string, Promise<LoadedTool>>;
    let headers: Map<string, Uint8Array>;
    let gch: Uint8Array | undefined;
    const linkFilesP = Promise.all(m.link.files.map(async (f) => [f.path, await c.store.get(f)] as const));
    const libsP = Promise.all(libArchives.map(async (l) => [`${m.fs.cwd}/${l.archive.path}`, await c.store.get(l.archive)] as const));
    const libObjsP = Promise.all(libObjects.map(async (o) => [o.path, await c.store.get(o)] as const));
    const ebootP = m.output.kind === "esp8266-image" ? c.store.get(m.output.eboot) : undefined;
    const lazyP = m.link.lazy ? c.lazy(m) : undefined;
    const imagesP = m.output.kind === "esp-image" ? Promise.all(m.output.images.map(async (i) => ({ name: i.name, address: i.address, data: await c.store.get(i) }))) : undefined;
    for (const p of [linkFilesP, libsP, libObjsP, ebootP, lazyP, imagesP]) p?.catch(() => {});
    try {
        toolsP = Object.fromEntries(needTools.map((t) => [t, c.tool(m, t)]));
        [headers, gch] = await Promise.all([c.headers(m), usePch ? c.store.get(m.pch!.gch) : undefined]);
        await Promise.all(Object.values(toolsP));
    } catch (e) {
        return fail([err(`download failed: ${(e as Error).message}`)]);
    }
    stats.phases.download = Math.round(now() - tDl);

    // ---- compile
    const tCc = now();
    const totalSteps = tus.length + libTus.length;
    pr.phase("compile", 0, totalSteps);
    const srcFiles = new Map<string, Uint8Array>();
    const enc = new TextEncoder();
    for (const f of files) srcFiles.set(`${m.fs.srcDir}/${f.path}`, enc.encode(f.content));
    for (const t of tus) srcFiles.set(`${m.fs.srcDir}/${t.path}`, enc.encode(t.source));
    const projectHeaders = files.filter((f) => /\.(h|hpp)$/.test(f.path)).map((f) => `${f.path}\n${f.content}`);
    const pchFiles = new Map<string, Uint8Array>();
    if (usePch && gch) {
        pchFiles.set(m.pch!.path, gch);
        const real = headers.get(m.pch!.header);
        if (real) pchFiles.set(m.pch!.path.replace(/\.gch$/, ""), real);
    }
    // every registry library's files at their virtual paths (one shared file set)
    const regFiles = new Map<string, Uint8Array>();
    for (const l of regLibs) for (const [rel, data] of l.build.files) regFiles.set(`${l.build.root}/${rel}`, data);
    const regKey = installed.map((p) => p.sha256).sort().join(",");
    // The paths depend on the board (`.pio/libdeps/<env>/…`): a pool worker that kept this set
    // from another board's build must not reuse it, so the id names pack and board too.
    if (regFiles.size) tagFileset(regFiles, `registry:${m.packVersion}:${m.id}:${regKey}`);
    const extra = c.extraHeaders(m);
    const resolver = m.headerIndex ? c.headerResolver(m) : null;
    // `__has_include(<x>)` does not fail on a header the bundle lacks, it silently takes the other
    // branch: fetch every such framework header up front (and those its fetched headers probe)
    if (resolver) {
        const HAS = /__has_include(?:_next)?\s*\(\s*([<"])([^>"]+)[>"]\s*\)/g;
        const queue: string[] = [];
        const dec = new TextDecoder();
        const scan = (text: string) => {
            for (const mm of text.matchAll(HAS)) if (!queue.includes(mm[2]!)) queue.push(mm[2]!);
        };
        for (const f of files) scan(f.content);
        for (const t of tus) scan(t.source);
        for (const l of usedReg) for (const d of l.build.files.values()) if (d.length < 2_000_000) scan(dec.decode(d));
        for (let i = 0; i < queue.length && i < 400; i++) {
            const name = queue[i]!;
            const hit = await resolver.find(name, null, false).catch(() => null);
            if (!hit || headers.has(hit.path) || extra.files.has(hit.path)) continue;
            extra.add(hit.path, hit.data);
            scan(dec.decode(hit.data));
        }
    }
    const objects = new Map<string, Uint8Array>(); // ".pio/build/<env>/src/x.o" → bytes
    let done = 0;
    let failed = false;
    const missing: Array<{ header: string; file: string | null; line: number | null }> = [];
    const exec = tus.length + libTus.length > 1 && opts.executor ? opts.executor : inlineExecutor;
    const objPath = (t: Tu) => `${m.fs.buildDir}/src/${t.path}.o`;

    // At most a few tool instances at once (each is a whole compiler with its own memory): inline
    // 2, a worker pool twice its size. Hundreds of library TUs at once run out of memory.
    const slots = exec === inlineExecutor ? 2 : Math.max(2, 2 * ((exec as { size?: number }).size ?? 4));
    let active = 0;
    const waiting: Array<() => void> = [];
    const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= slots) await new Promise<void>((res) => waiting.push(res));
        active++;
        try {
            return await fn();
        } finally {
            active--;
            waiting.shift()?.();
        }
    };
    /**
     * A fetched framework header's own includes that the bundle lacks (resolvable in the index),
     * transitively: one compiler run per missing header would otherwise be one retry each.
     */
    const fetchClosure = async (path: string, data: Uint8Array) => {
        const queue: Array<[string, Uint8Array]> = [[path, data]];
        const dec = new TextDecoder();
        for (let n = 0; queue.length && n < 500; n++) {
            const [p, d] = queue.shift()!;
            for (const inc of scanIncludes(dec.decode(d))) {
                const hit = await resolver!.find(inc.name, p, inc.quoted).catch(() => null);
                if (!hit || headers.has(hit.path) || extra.files.has(hit.path)) continue;
                // a quoted include next to the includer, or one the bundle has elsewhere on the path, is found by the compiler already
                if (!inc.quoted && [...headers.keys()].some((h) => h.endsWith(`/${inc.name}`))) continue;
                extra.add(hit.path, hit.data);
                queue.push([hit.path, hit.data]);
            }
        }
    };
    /** cc1/cc1plus (+ framework headers fetched on demand, then retried) and as. */
    const runTu = (job: Parameters<typeof runTuNow>[0]) => limited(() => runTuNow(job));
    const runTuNow = async (job: { cc: ToolName | null; ccArgv: string[]; asArgv: string[]; asm: string; obj: string; files: Array<Map<string, Uint8Array>>; objDir: string; label?: string }): Promise<Uint8Array | null> => {
        let asmData: Uint8Array | undefined;
        let asInput = job.asm;
        if (job.cc) {
            for (let round = 0; ; round++) {
                const seen = extra.files; // another TU may add headers while this one runs
                const r1 = await exec.run(await toolsP[job.cc]!, job.ccArgv, {
                    files: [...job.files, seen],
                    cwd: m.fs.cwd,
                    mkdirs: [...m.fs.mkdirs, `${m.fs.cwd}/${job.objDir}`],
                    thisProgram: m.tools[job.cc].thisProgram,
                    outputs: [job.asm],
                    ...(m.sourceDateEpoch !== undefined ? { env: { SOURCE_DATE_EPOCH: String(m.sourceDateEpoch) } } : {}),
                });
                asmData = r1.outputs.get(job.asm);
                if (r1.code === 0 && asmData) {
                    if (r1.output.trim()) log.push(r1.output);
                    break;
                }
                const miss = missingIncludes(r1.output, m.fs.cwd);
                let fetched = false;
                if (resolver && miss.length && round < 64) {
                    for (const x of miss) {
                        const hit = await resolver.find(x.header, x.file, x.quoted).catch(() => null);
                        if (hit && !seen.has(hit.path)) {
                            if (!extra.files.has(hit.path)) {
                                extra.add(hit.path, hit.data);
                                await fetchClosure(hit.path, hit.data);
                            }
                            fetched = true;
                        }
                    }
                }
                if (fetched) continue;
                log.push(r1.output);
                for (const x of miss) missing.push(x);
                if (r1.code !== 1 && !/error/.test(r1.output)) log.push(`${job.cc} exited with ${r1.code}`);
                return null;
            }
        } else asInput = job.asm;
        const r2 = await exec.run(await toolsP.as!, job.asArgv, {
            files: job.cc ? [new Map([[job.asm, asmData!]])] : job.files,
            cwd: m.fs.cwd,
            mkdirs: [...m.fs.mkdirs, `${m.fs.cwd}/${job.objDir}`],
            thisProgram: m.tools.as.thisProgram,
            outputs: [`${m.fs.cwd}/${job.obj}`],
        });
        void asInput;
        if (r2.output.trim()) log.push(r2.output);
        const obj = r2.outputs.get(`${m.fs.cwd}/${job.obj}`);
        return r2.code === 0 && obj ? obj : null;
    };

    await Promise.all([
        ...tus.map(async (t, i) => {
            const cc: ToolName = t.lang === "cpp" ? "cc1plus" : "cc1";
            const tmpl = t.lang === "cpp" ? m.compile.cpp.cc1plus : m.compile.c.cc1;
            const asTmpl = t.lang === "cpp" ? m.compile.cpp.as : m.compile.c.as;
            const vars = { SRC: `src/${t.path}`, DUMPBASE: t.path.split("/").pop()!, OBJ: objPath(t), OBJDIR: dirOf(objPath(t)), ASM: `/tmp/tu${i}.s` };
            let argv = expandArgs(projectFlags.length ? applyFlags(tmpl, projectFlags) : tmpl, vars, { LIBINC: ldf.includeArgs });
            if (t.pch && usePch) argv = [...m.pch!.args, ...argv];
            const asArgv = expandArgs(asTmpl, vars);
            const key = opts.cache === false ? null : await sha256Hex([m.packVersion, m.id, JSON.stringify(argv), JSON.stringify(asArgv), t.source, ...projectHeaders, regKey]);
            const hit = key ? c.objects.get(key) : undefined;
            if (hit) {
                stats.cached++;
                objects.set(vars.OBJ, hit);
                pr.phase("compile", ++done, totalSteps);
                return;
            }
            const obj = await runTu({ cc, ccArgv: argv, asArgv, asm: vars.ASM, obj: vars.OBJ, objDir: dirOf(vars.OBJ), files: [headers, srcFiles, pchFiles, ...(regFiles.size ? [regFiles] : [])] });
            if (!obj) {
                failed = true;
                return;
            }
            stats.compiled++;
            objects.set(vars.OBJ, obj);
            if (key) c.objects.set(key, obj);
            pr.phase("compile", ++done, totalSteps);
        }),
        ...libTus.map(async (t) => {
            const l = t.lib;
            const inc = ldf.libIncludeArgs?.get(l.entry) ?? l.entry.includeDirs.flatMap((d) => ["-I", d]);
            const base = t.kind === "cpp" ? m.compile.cpp : t.kind === "c" ? m.compile.c : null;
            const ccTmpl = base ? ("cc1plus" in base ? base.cc1plus : base.cc1) : t.kind === "S" ? m.compileAsm!.S.cc1 : null;
            const asTmpl = base ? base.as : t.kind === "S" ? m.compileAsm!.S.as : m.compileAsm!.s.as;
            const cc: ToolName | null = t.kind === "cpp" ? "cc1plus" : t.kind === "c" || t.kind === "S" ? "cc1" : null;
            const vars = { SRC: t.src, DUMPBASE: t.src.split("/").pop()!, OBJ: t.obj, OBJDIR: dirOf(t.obj), ASM: `/tmp/lib${t.index}.s` };
            const flags = [...projectFlags, ...l.build.flags];
            const ccArgv = ccTmpl ? expandArgs(applyFlags(libTemplate(ccTmpl), flags, l.build.unflags), vars, { LIBINC: inc }) : [];
            const asArgv = expandArgs(asTmpl, vars, { LIBINC: inc });
            const key = opts.cache === false ? null : await sha256Hex(["lib-v1", m.packVersion, m.id, JSON.stringify(ccArgv), JSON.stringify(asArgv), pkgOf(l).sha256, regKey]);
            const hit = key ? await c.persistent(opts).get(key) : undefined;
            if (hit) {
                stats.cached++;
                stats.registry!.cached++;
                objects.set(t.obj, hit);
                pr.phase("compile", ++done, totalSteps);
                return;
            }
            pr.label(l.entry.name);
            const fileSets = [headers, regFiles];
            const obj = await runTu({ cc, ccArgv, asArgv, asm: cc ? vars.ASM : `${m.fs.cwd}/${t.src}`, obj: t.obj, objDir: dirOf(t.obj), files: fileSets, label: l.entry.name });
            if (!obj) {
                failed = true;
                return;
            }
            stats.compiled++;
            stats.registry!.compiled++;
            objects.set(t.obj, obj);
            if (key) await c.persistent(opts).set(key, obj);
            pr.phase("compile", ++done, totalSteps);
        }),
    ]);
    pr.label(undefined);
    stats.phases.compile = Math.round(now() - tCc);
    const diag = () => parseDiagnostics(log.join("\n"), diagCtx);
    if (failed) {
        const d = diag();
        const extraOut: Partial<CompileResult> = {};
        if (missing.length) extraOut.missingHeaders = await suggestMissing(missing, m, diagCtx, opts);
        if (!extraOut.missingHeaders?.length) {
            // a used registry library that declares other platforms: say so rather than its compile errors only
            const foreign = usedReg.find((l) => l.manifest.platforms?.length && !itemsInList(m.registry!.platform, l.manifest.platforms));
            if (foreign) extraOut.problem = { kind: "libIncompatible", spec: pkgOf(foreign).requestedBy, platform: m.registry!.platform };
        }
        return fail(d.errors.length ? d.errors : [err("compilation failed")], d.warnings, extraOut);
    }

    // registry libraries: archives (lib_archive) or single objects, in build (link) order
    const regArchives = new Map<LibraryEntry, { path: string; data: Uint8Array }>();
    const regObjects = new Map<LibraryEntry, Array<{ path: string; data: Uint8Array }>>();
    for (const l of usedReg) {
        const objs = libTus.filter((t) => t.lib === l).map((t) => ({ path: t.obj, data: objects.get(t.obj)! }));
        if (!objs.length) continue;
        if (regArchive(l)) {
            const bd = await libBuildDir(m, l);
            const path = `${bd.slice(0, bd.lastIndexOf("/"))}/lib${bd.slice(bd.lastIndexOf("/") + 1)}.a`;
            regArchives.set(l.entry, { path, data: libraryArchive(objs) });
        } else regObjects.set(l.entry, objs);
    }

    // ---- link
    const tLd = now();
    pr.phase("link", 0, 1);
    let packLibObjs: ReadonlyArray<readonly [string, Uint8Array]>;
    let packArchives: ReadonlyArray<readonly [string, Uint8Array]>;
    try {
        packLibObjs = await libObjsP;
        packArchives = await libsP;
    } catch (e) {
        return fail([err(`download failed: ${(e as Error).message}`)]);
    }
    // pio's link line: library objects (lib_archive = no) first, in build order, then the sketch's
    const libObjs: Array<readonly [string, Uint8Array]> = [];
    const archives: Array<readonly [string, Uint8Array]> = []; // absolute path → bytes, link order
    const archivePaths: string[] = [];
    for (const l of ldf.libraries) {
        const ro = regObjects.get(l);
        if (ro) for (const o of ro) libObjs.push([o.path, o.data]);
        for (const o of l.objects ?? []) libObjs.push([o.path, packLibObjs.find(([p]) => p === o.path)![1]]);
        const ra = regArchives.get(l);
        if (ra) {
            archives.push([`${m.fs.cwd}/${ra.path}`, ra.data]);
            archivePaths.push(ra.path);
        }
        if (l.archive) {
            archives.push([`${m.fs.cwd}/${l.archive.path}`, packArchives.find(([p]) => p === `${m.fs.cwd}/${l.archive!.path}`)![1]]);
            archivePaths.push(l.archive.path);
        }
    }
    const objList = [...libObjs.map(([p]) => p), ...tus.map(objPath)];
    const sketchObjs = new Map(tus.map((t) => [objPath(t), objects.get(objPath(t))!]));
    const linkFiles = new Map<string, Uint8Array>(await linkFilesP);
    for (const [p, d] of archives) linkFiles.set(p, d);
    for (const [p, d] of libObjs) linkFiles.set(`${m.fs.cwd}/${p}`, d);
    for (const [p, d] of sketchObjs) linkFiles.set(`${m.fs.cwd}/${p}`, d);
    const intermediates = opts.keepIntermediates ? new Map<string, Uint8Array>() : undefined;
    if (lazyP) {
        let lz: Awaited<typeof lazyP>;
        try {
            lz = await lazyP;
        } catch (e) {
            return fail([err(`download failed: ${(e as Error).message}`)]);
        }
        const tRes = now();
        const objBytes = new Map<string, Uint8Array>([...libObjs, ...sketchObjs]);
        const { archives: mini, linked, fetched } = await lazyArchives(c, m, lz, objList.map((p) => objBytes.get(p)!), archives, pr.bytes);
        for (const [p, d] of mini) {
            linkFiles.set(p, d);
            intermediates?.set(p, d);
        }
        stats.members = { linked, fetched };
        stats.phases.resolve = Math.round(now() - tRes);
    }
    const elfPath = `${m.fs.buildDir}/firmware.elf`;
    const ldArgv = expandArgs(ldTemplate(m), { ELF: elfPath }, { OBJS: objList, LIBS: archivePaths });
    const ld = await toolsP.ld!;
    const r = await inlineExecutor.run(ld, ldArgv, { files: linkFiles, cwd: m.fs.cwd, mkdirs: m.fs.mkdirs, thisProgram: m.tools.ld.thisProgram, outputs: [`${m.fs.cwd}/${elfPath}`] });
    if (r.output.trim()) log.push(r.output);
    const elf = r.outputs.get(`${m.fs.cwd}/${elfPath}`);
    stats.phases.link = Math.round(now() - tLd);
    if (r.code !== 0 || !elf) {
        const d = diag();
        return fail(d.errors.length ? d.errors : [err(`linking failed (ld exit ${r.code})`)], d.warnings);
    }
    if (intermediates) {
        for (const [p, d] of libObjs) intermediates.set(`${m.fs.cwd}/${p}`, d);
        for (const [p, d] of sketchObjs) intermediates.set(`${m.fs.cwd}/${p}`, d);
        for (const [p, d] of archives) if (!p.startsWith(`${m.fs.cwd}/${m.fs.buildDir}/lib`) || [...regArchives.values()].some((a) => `${m.fs.cwd}/${a.path}` === p)) intermediates.set(p, d);
        intermediates.set(`${m.fs.cwd}/${elfPath}`, elf);
    }

    // ---- post
    const tPost = now();
    const out: FirmwareImage[] = [];
    const e = new ElfFile(elf);
    if (m.output.kind === "hex") {
        out.push({ name: "firmware.hex", data: enc.encode(elfToIntelHex(e, { remove: m.output.remove })) });
    } else if (m.output.kind === "esp8266-image") {
        out.push({ name: "firmware.bin", address: m.output.appAddress, data: elfToEsp8266Image(elf, (await ebootP)!, m.output.image) });
    } else {
        out.push({ name: "firmware.bin", address: m.output.appAddress, data: await elfToEspImage(elf, m.output.image) });
        for (const img of (await imagesP)!) out.push(img);
    }
    const size = sizeReport(e, m.size);
    log.push(formatSizeReport(size));
    const problems = sizeProblems(size);
    stats.phases.post = Math.round(now() - tPost);
    const d = diag();
    for (const w of problems.warnings) d.warnings.push(err(w));
    for (const x of problems.errors) d.errors.push(err(x.replace(/^Error: /, "")));
    stats.downloadedBytes = c.store.downloaded - downloadedBefore + (regClient ? regClient.downloaded - regDownloadedBefore : 0);
    pr.phase("done", 1, 1);
    return {
        ok: d.errors.length === 0,
        board: request.board,
        errors: d.errors,
        warnings: [...extraWarnings, ...d.warnings],
        size,
        files: d.errors.length ? [] : out,
        log: log.join("\n"),
        durationMs: Math.round(now() - t0),
        stats,
        ...(intermediates ? { intermediates, link: { objects: objList, archives: archivePaths } } : {}),
    };
}

/** The link template with `${LIBS}` (packs without library archives: first in the group, where PlatformIO puts them). */
export function ldTemplate(m: BoardManifest): string[] {
    if (m.link.ld.includes("${LIBS}")) return m.link.ld;
    const ld = [...m.link.ld];
    const g = ld.indexOf("--start-group");
    ld.splice(g >= 0 ? g + 1 : ld.length, 0, "${LIBS}");
    return ld;
}

/** Missing headers → up to three registry libraries each (framework + the board's platform). */
async function suggestMissing(missing: Array<{ header: string; file: string | null; line: number | null }>, m: BoardManifest, ctx: DiagnosticContext, opts: CompileOptions): Promise<MissingHeader[]> {
    const out: MissingHeader[] = [];
    const seen = new Set<string>();
    const client = registryClient({ registryBase: opts.registryBase, fetch: opts.registryFetch, cacheStorage: opts.cacheStorage });
    for (const x of missing) {
        if (seen.has(x.header)) continue;
        seen.add(x.header);
        let suggestions: MissingHeader["suggestions"] = [];
        try {
            suggestions = await suggestForHeader(client, x.header, { platform: m.registry?.platform ?? (m.arch === "avr" ? "atmelavr" : m.arch === "esp8266" ? "espressif8266" : "espressif32"), framework: m.registry?.framework ?? "arduino", limit: 3 });
        } catch {
            suggestions = [];
        }
        out.push({ header: x.header, file: x.file ? mapPath(x.file, ctx) : null, line: x.line, suggestions });
    }
    return out;
}

/** Resolver view of a lazy archive, built once per link index. */
const archiveIndexMemo = new WeakMap<LinkIndex, Map<number, ArchiveIndex>>();

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function indexSyms(x: { d?: number[]; w?: number[]; c?: number[]; u?: number[]; uw?: number[] }, s: string[]): ObjSymbol[] {
    const out: ObjSymbol[] = [];
    const add = (ids: number[] | undefined, kind: ObjSymbol["kind"]) => ids?.forEach((i) => out.push({ name: s[i]!, kind }));
    add(x.d, "def");
    add(x.w, "weakdef");
    add(x.c, "common");
    add(x.u, "undef");
    add(x.uw, "weakundef");
    return out;
}

function archiveIndexOf(data: Uint8Array): ArchiveIndex {
    const ar = readArchive(data);
    return {
        members: ar.members.map((mm) => ({ name: mm.name, size: mm.data.length, syms: safeSyms(mm.data) })),
        armap: (ar.index ?? []).map((x) => [x.symbol, x.member] as [string, number]),
    };
}

function safeSyms(d: Uint8Array): ObjSymbol[] {
    try {
        return elfSymbols(d);
    } catch {
        return [];
    }
}

/**
 * Lazy linking: which framework archive members will ld load? Fetch those not in the base blob
 * and write one archive per framework archive with just them (same path, member names and
 * order, armap filtered), an empty archive where nothing is needed.
 */
async function lazyArchives(
    c: Compiler,
    m: BoardManifest,
    lz: { index: LinkIndex; base: Map<string, Uint8Array> },
    objs: Uint8Array[],
    libs: ReadonlyArray<readonly [string, Uint8Array]>,
    onBytes: (n: number) => void,
): Promise<{ archives: Map<string, Uint8Array>; linked: number; fetched: number }> {
    const { index, base } = lz;
    const S = index.strings;
    const inputs: ResolveInput[] = [];
    let memoIdx = archiveIndexMemo.get(index);
    if (!memoIdx) archiveIndexMemo.set(index, (memoIdx = new Map()));
    const archIdx = (ai: number): ArchiveIndex => {
        let x = memoIdx.get(ai);
        if (!x) {
            const a = index.archives[ai]!;
            const armap: Array<[string, number]> = [];
            a.members.forEach((mm, mi) => mm.a?.forEach((s) => armap.push([S[s]!, mi])));
            x = { members: a.members.map((mm) => ({ name: mm.n, size: mm.s, syms: indexSyms(mm, S) })), armap };
            memoIdx!.set(ai, x);
        }
        return x;
    };
    for (const inp of index.inputs) {
        if (inp.kind === "objects") objs.forEach((o, i) => inputs.push({ kind: "object", path: `sketch${i}`, syms: elfSymbols(o) }));
        else if (inp.kind === "libs") for (const [p, d] of libs) inputs.push({ kind: "archive", path: p, index: archiveIndexOf(d) });
        else if (inp.kind === "object") inputs.push({ kind: "object", path: inp.path, syms: indexSyms(inp.syms, S) });
        else if (inp.kind === "archive") inputs.push({ kind: "archive", path: `#${inp.archive}`, index: archIdx(inp.archive) });
        else inputs.push({ kind: inp.kind });
    }
    const res = resolve(inputs, index.roots, index.wraps);
    const need: Array<{ ai: number; mi: number; mm: IndexMember }> = [];
    for (const [path, ms] of res.members) {
        if (!path.startsWith("#")) continue;
        const ai = Number(path.slice(1));
        for (const mi of ms) need.push({ ai, mi, mm: index.archives[ai]!.members[mi]! });
    }
    const missing = need.filter((x) => !base.has(x.mm.h));
    const fetchedData = new Map<string, Uint8Array>();
    const refOf = (mm: IndexMember): FileRef => ({ file: `files/${mm.h}.o`, size: mm.s, sha256: mm.h });
    // bounded parallelism: hundreds of small files
    let k = 0;
    await Promise.all(
        Array.from({ length: Math.min(16, missing.length) }, async () => {
            while (k < missing.length) {
                const x = missing[k++]!;
                fetchedData.set(x.mm.h, await c.store.get(refOf(x.mm), onBytes));
            }
        }),
    );
    const archives = new Map<string, Uint8Array>();
    index.archives.forEach((a, ai) => {
        const ms = res.members.get(`#${ai}`) ?? [];
        const members: ArMember[] = [];
        const armapOf = new Map<ArMember, string[]>();
        for (const mi of ms) {
            const mm = a.members[mi]!;
            const am: ArMember = { name: mm.n, data: base.get(mm.h) ?? fetchedData.get(mm.h)! };
            members.push(am);
            armapOf.set(am, (mm.a ?? []).map((s) => S[s]!));
        }
        archives.set(a.path, members.length ? writeArchive(members, { symbols: (mm) => armapOf.get(mm) ?? [] }) : writeArchive([], { symbols: "none" }));
    });
    void m;
    return { archives, linked: need.length, fetched: missing.length };
}
