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
import { ObjectCache, PackStore, sha256Hex, type StoreOptions } from "./cache";
import { parseDiagnostics, type DiagnosticContext } from "./diagnostics";
import { expandArgs, loadTool, runTool, tagFileset, type LoadedTool, type RunOptions, type RunResult } from "./driver";
import { ElfFile } from "./elf";
import { elfToEspImage } from "./esp-image";
import { elfToEsp8266Image } from "./esp8266-image";
import { elfToIntelHex } from "./hex";
import { inoToCpp, PreprocessUnsupportedError } from "./ino";
import { selectLibraries } from "./ldf";
import type { BoardManifest, FileRef, IndexMember, LibraryEntry, LinkIndex, PackIndex, ToolName } from "./manifest";
import { resolve, type ArchiveIndex, type ResolveInput } from "./resolve";
import { formatSizeReport, sizeProblems, sizeReport } from "./size";
import { elfSymbols, type ObjSymbol } from "./symbols";
import type { CompileProgress, CompileRequest, CompileResponse, CompileStats, Diagnostic, FirmwareImage, SourceFile } from "./types";

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
}

export interface CompileResult extends CompileResponse {
    /** With `keepIntermediates`: absolute virtual path → bytes of objects, archives and the ELF. */
    intermediates?: Map<string, Uint8Array>;
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

/** Progress over a known total of bytes. */
function progressTracker(onProgress: CompileOptions["onProgress"]) {
    let loaded = 0;
    let total = 0;
    let phase: CompileProgress["phase"] = "download";
    const emit = () => onProgress?.({ phase, loaded, total });
    return {
        expect(n: number) {
            total += n;
            emit();
        },
        bytes: (n: number) => {
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
    const fail = (errors: Diagnostic[], warnings: Diagnostic[] = []): CompileResult => {
        stats.downloadedBytes = c.store.downloaded - downloadedBefore;
        return { ok: false, board: request.board, errors, warnings, files: [], log: log.join("\n"), durationMs: Math.round(now() - t0), stats };
    };
    const err = (message: string): Diagnostic => ({ file: null, line: null, column: null, message });

    let m: BoardManifest;
    try {
        m = await c.manifest(request.board);
    } catch (e) {
        return fail([err((e as Error).message)]);
    }

    // ---- request → project files
    const own = new Map<string, string>(); // "src/<p>" → caller path
    const files: SourceFile[] = [];
    for (const f of request.files) {
        const p = f.path.replace(/^\.\//, "").replace(/^src\//, "");
        if (!FILE_RE.test(p) || p.split("/").some((s) => s === "." || s === "..")) return fail([err(`file "${f.path}": only .ino, .pde, .cpp, .c, .h and .hpp files with a relative path`)]);
        if (own.has(`src/${p}`)) return fail([err(`file "${f.path}" is there twice`)]);
        own.set(`src/${p}`, f.path);
        files.push({ path: p, content: f.content });
    }
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
    const exec = tus.length > 1 && opts.executor ? opts.executor : inlineExecutor;
    const diagCtx: DiagnosticContext = {
        cwd: m.fs.cwd,
        paths: own,
        mainIno,
        strip: [/^\/opt\/pio\/packages\//, /^\/opt\/pio-libs\/[^/]+\//],
    };

    // ---- libraries
    const projectForLdf: SourceFile[] = [...tus.map((t) => ({ path: t.path, content: t.source })), ...files.filter((f) => /\.(h|hpp)$/.test(f.path))];
    const ldf = selectLibraries(projectForLdf, m.libraries);
    stats.libraries = ldf.libraries.map((l) => l.name);
    const libArchives = ldf.libraries.filter((l): l is LibraryEntry & { archive: NonNullable<LibraryEntry["archive"]> } => !!l.archive);

    // ---- downloads
    const tDl = now();
    const pr = progressTracker(opts.onProgress);
    const usePch = !!m.pch && opts.usePch !== false && tus.some((t) => t.pch);
    const needTools: ToolName[] = ["as", "ld", ...(tus.some((t) => t.lang === "cpp") ? (["cc1plus"] as const) : []), ...(tus.some((t) => t.lang === "c") ? (["cc1"] as const) : [])];
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
    pr.phase("compile", 0, tus.length);
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
    const objects = new Map<string, Uint8Array>(); // ".pio/build/<env>/src/x.o" → bytes
    let done = 0;
    let failed = false;
    const objPath = (t: Tu) => `${m.fs.buildDir}/src/${t.path}.o`;
    await Promise.all(
        tus.map(async (t, i) => {
            const cc: ToolName = t.lang === "cpp" ? "cc1plus" : "cc1";
            const tmpl = t.lang === "cpp" ? m.compile.cpp.cc1plus : m.compile.c.cc1;
            const asTmpl = t.lang === "cpp" ? m.compile.cpp.as : m.compile.c.as;
            const vars = { SRC: `src/${t.path}`, DUMPBASE: t.path.split("/").pop()!, OBJ: objPath(t), OBJDIR: dirOf(objPath(t)), ASM: `/tmp/tu${i}.s` };
            let argv = expandArgs(tmpl, vars, { LIBINC: ldf.includeArgs });
            if (t.pch && usePch) argv = [...m.pch!.args, ...argv];
            const asArgv = expandArgs(asTmpl, vars);
            const key = opts.cache === false ? null : await sha256Hex([m.packVersion, m.id, JSON.stringify(argv), JSON.stringify(asArgv), t.source, ...projectHeaders]);
            const hit = key ? c.objects.get(key) : undefined;
            if (hit) {
                stats.cached++;
                objects.set(vars.OBJ, hit);
                pr.phase("compile", ++done, tus.length);
                return;
            }
            const r1 = await exec.run(await toolsP[cc]!, argv, {
                files: [headers, srcFiles, pchFiles],
                cwd: m.fs.cwd,
                mkdirs: [...m.fs.mkdirs, `${m.fs.cwd}/${m.fs.buildDir}/src`],
                thisProgram: m.tools[cc].thisProgram,
                outputs: [vars.ASM],
            });
            if (r1.output.trim()) log.push(r1.output);
            const asm = r1.outputs.get(vars.ASM);
            if (r1.code !== 0 || !asm) {
                failed = true;
                if (r1.code !== 1 && !/error/.test(r1.output)) log.push(`${cc} exited with ${r1.code}`);
                return;
            }
            const r2 = await exec.run(await toolsP.as!, asArgv, {
                files: new Map([[vars.ASM, asm]]),
                cwd: m.fs.cwd,
                mkdirs: [...m.fs.mkdirs, `${m.fs.cwd}/${m.fs.buildDir}/${dirOf(`src/${t.path}`)}`],
                thisProgram: m.tools.as.thisProgram,
                outputs: [`${m.fs.cwd}/${vars.OBJ}`],
            });
            if (r2.output.trim()) log.push(r2.output);
            const obj = r2.outputs.get(`${m.fs.cwd}/${vars.OBJ}`);
            if (r2.code !== 0 || !obj) {
                failed = true;
                return;
            }
            stats.compiled++;
            objects.set(vars.OBJ, obj);
            if (key) c.objects.set(key, obj);
            pr.phase("compile", ++done, tus.length);
        }),
    );
    stats.phases.compile = Math.round(now() - tCc);
    const diag = () => parseDiagnostics(log.join("\n"), diagCtx);
    if (failed) {
        const d = diag();
        return fail(d.errors.length ? d.errors : [err("compilation failed")], d.warnings);
    }

    // ---- link
    const tLd = now();
    pr.phase("link", 0, 1);
    let libObjs: ReadonlyArray<readonly [string, Uint8Array]>;
    try {
        libObjs = await libObjsP;
    } catch (e) {
        return fail([err(`download failed: ${(e as Error).message}`)]);
    }
    // pio's link line: library objects (lib_archive = no) first, then the sketch's
    const objList = [...libObjs.map(([p]) => p), ...tus.map(objPath)];
    const linkFiles = new Map<string, Uint8Array>(await linkFilesP);
    for (const [p, d] of await libsP) linkFiles.set(p, d);
    for (const [p, d] of libObjs) linkFiles.set(`${m.fs.cwd}/${p}`, d);
    for (const [p, d] of objects) linkFiles.set(`${m.fs.cwd}/${p}`, d);
    const intermediates = opts.keepIntermediates ? new Map<string, Uint8Array>() : undefined;
    if (lazyP) {
        let lz: Awaited<typeof lazyP>;
        try {
            lz = await lazyP;
        } catch (e) {
            return fail([err(`download failed: ${(e as Error).message}`)]);
        }
        const tRes = now();
        const objBytes = new Map<string, Uint8Array>([...libObjs, ...objects]);
        const { archives, linked, fetched } = await lazyArchives(c, m, lz, objList.map((p) => objBytes.get(p)!), await libsP, pr.bytes);
        for (const [p, d] of archives) {
            linkFiles.set(p, d);
            intermediates?.set(p, d);
        }
        stats.members = { linked, fetched };
        stats.phases.resolve = Math.round(now() - tRes);
    }
    const elfPath = `${m.fs.buildDir}/firmware.elf`;
    const ldArgv = expandArgs(m.link.ld, { ELF: elfPath }, { OBJS: objList, LIBS: libArchives.map((l) => l.archive.path) });
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
        for (const [p, d] of objects) intermediates.set(`${m.fs.cwd}/${p}`, d);
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
    stats.downloadedBytes = c.store.downloaded - downloadedBefore;
    pr.phase("done", 1, 1);
    return {
        ok: d.errors.length === 0,
        board: request.board,
        errors: d.errors,
        warnings: d.warnings,
        size,
        files: d.errors.length ? [] : out,
        log: log.join("\n"),
        durationMs: Math.round(now() - t0),
        stats,
        ...(intermediates ? { intermediates } : {}),
    };
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
