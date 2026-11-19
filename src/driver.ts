/**
 * Runs one compiler tool (cc1plus, cc1, as, ld — Emscripten MODULARIZE builds exporting
 * `createTool`) on an in-memory file system. Browser-safe: no node: imports; the same code runs
 * in a Web Worker, on a page and under Node/Bun.
 *
 * Rules learned in phase 0 (spike/*\/FINDINGS.md):
 *  - one fresh instance per run from an already compiled WebAssembly.Module (1–5 ms);
 *  - `thisProgram` = the tool's native path in the virtual FS (ld finds its default linker
 *    scripts relative to argv[0]);
 *  - `callMain` mutates the array it gets (unshifts argv[0]): always pass a copy;
 *  - `quit` throws; the exit status comes back from callMain / the thrown ExitStatus;
 *  - every directory a path walks through with ".." must exist (MEMFS resolves "a/../b" only if a exists).
 */
import type { ToolName } from "./manifest";

/** The Emscripten factory: `createTool(moduleArg) → Promise<Module>`. */
export type ToolFactory = (moduleArg: Record<string, unknown>) => Promise<EmscriptenModule>;

interface EmscriptenFS {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array | string, opts?: { canOwn?: boolean }): void;
    readFile(path: string): Uint8Array;
    analyzePath(path: string): { exists: boolean };
    chdir(path: string): void;
}

interface EmscriptenModule {
    FS: EmscriptenFS;
    callMain(args: string[]): number | undefined;
}

export interface LoadedTool {
    /** Stable id (the wasm sha256), lets workers cache the instance factory. */
    id?: string;
    name: ToolName | string;
    module: WebAssembly.Module;
    factory: ToolFactory;
    /** The glue source (posted to workers, which build their own factory). */
    js: string;
}

/**
 * Evaluates the Emscripten glue without letting it detect Node (`process`, `require`,
 * `__filename` shadowed): it then uses MEMFS only and never touches the host file system.
 * Needs `unsafe-eval` under a Content-Security-Policy.
 */
export function factoryFromSource(js: string): ToolFactory {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const f = new Function("process", "require", "__filename", "__dirname", `${js}\nreturn createTool;`);
    return f(undefined, undefined, undefined, undefined) as ToolFactory;
}

export async function loadTool(name: string, js: string, wasm: WebAssembly.Module | BufferSource | Response | PromiseLike<Response>): Promise<LoadedTool> {
    let module: WebAssembly.Module;
    if (wasm instanceof WebAssembly.Module) module = wasm;
    else if (typeof (wasm as PromiseLike<Response>).then === "function" || (typeof Response !== "undefined" && wasm instanceof Response)) {
        const res = await (wasm as Response | PromiseLike<Response>);
        if (typeof WebAssembly.compileStreaming === "function" && res.headers.get("content-type")?.startsWith("application/wasm")) module = await WebAssembly.compileStreaming(res);
        else module = await WebAssembly.compile(await res.arrayBuffer());
    } else module = await WebAssembly.compile(wasm as BufferSource);
    return { name, module, factory: factoryFromSource(js), js };
}

/** Same as loadTool for raw bytes (pack builder, tests). */
export const loadToolFromFiles = (name: string, js: string, wasm: Uint8Array) => loadTool(name, js, wasm as BufferSource);

export interface RunOptions {
    /** Absolute path → content. Shared (canOwn) with the instance: never mutated by the tools. */
    files: Map<string, Uint8Array> | Array<Map<string, Uint8Array>>;
    cwd: string;
    mkdirs?: string[];
    thisProgram: string;
    /** Files to read back after the run (missing ones are skipped). */
    outputs?: string[];
}

export interface RunResult {
    code: number;
    /** stdout + stderr, in order. */
    output: string;
    outputs: Map<string, Uint8Array>;
    ms: { instantiate: number; fs: number; run: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export async function runTool(tool: LoadedTool, argv: string[], opts: RunOptions): Promise<RunResult> {
    const lines: string[] = [];
    const t0 = now();
    const M = await tool.factory({
        noInitialRun: true,
        thisProgram: opts.thisProgram,
        print: (s: string) => lines.push(s),
        printErr: (s: string) => lines.push(s),
        quit: (_status: number, toThrow: unknown) => {
            throw toThrow;
        },
        instantiateWasm(imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void) {
            WebAssembly.instantiate(tool.module, imports).then((inst) => done(inst, tool.module));
            return {};
        },
    });
    const t1 = now();
    const FS = M.FS;
    const made = new Set<string>();
    const mk = (d: string) => {
        if (!d || made.has(d)) return;
        FS.mkdirTree(d);
        made.add(d);
    };
    for (const d of opts.mkdirs ?? []) mk(d);
    mk("/tmp");
    mk(opts.cwd);
    const sets = Array.isArray(opts.files) ? opts.files : [opts.files];
    for (const set of sets) {
        for (const [p, data] of set) {
            mk(p.slice(0, p.lastIndexOf("/")) || "/");
            FS.writeFile(p, data, { canOwn: true });
        }
    }
    for (const o of opts.outputs ?? []) mk(o.startsWith("/") ? o.slice(0, o.lastIndexOf("/")) : `${opts.cwd}/${o.slice(0, Math.max(0, o.lastIndexOf("/")))}`);
    FS.chdir(opts.cwd);
    const t2 = now();
    let code: number;
    try {
        code = M.callMain([...argv]) ?? 0;
    } catch (e) {
        const st = (e as { status?: number })?.status;
        if (typeof st === "number") code = st;
        else {
            lines.push(String((e as Error)?.stack ?? e));
            code = -1;
        }
    }
    const t3 = now();
    const outputs = new Map<string, Uint8Array>();
    for (const o of opts.outputs ?? []) {
        try {
            if (FS.analyzePath(o).exists) outputs.set(o, FS.readFile(o));
        } catch {
            /* missing output */
        }
    }
    return { code, output: lines.join("\n"), outputs, ms: { instantiate: t1 - t0, fs: t2 - t1, run: t3 - t2 } };
}

const filesetIds = new WeakMap<Map<string, Uint8Array>, string>();

/** Marks a file map as immutable and shareable: a worker pool sends it to each worker once. */
export function tagFileset(map: Map<string, Uint8Array>, id: string) {
    filesetIds.set(map, id);
}

export const filesetId = (map: Map<string, Uint8Array>) => filesetIds.get(map);

/** `${NAME}` substitution; `${LIBINC}`-style list placeholders expand to several arguments. */
export function expandArgs(template: string[], vars: Record<string, string>, lists: Record<string, string[]> = {}): string[] {
    const out: string[] = [];
    for (const a of template) {
        const whole = /^\$\{(\w+)\}$/.exec(a);
        if (whole && whole[1]! in lists) {
            out.push(...lists[whole[1]!]!);
            continue;
        }
        out.push(
            a.replace(/\$\{(\w+)\}/g, (_, k: string) => {
                if (!(k in vars)) throw new Error(`argv template: no value for \${${k}}`);
                return vars[k]!;
            }),
        );
    }
    return out;
}
