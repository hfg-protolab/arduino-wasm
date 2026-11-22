/**
 * Main-thread side of the Web Worker integration (browser only; nothing here runs at import time):
 *
 *  - `createWorkerPool`: a ToolExecutor that runs tool invocations in N workers (worker.ts), so
 *    the translation units of a multi-file sketch compile in parallel. Compiled modules
 *    (WebAssembly.Module is structured-cloneable) and tagged file sets (the header bundle) are
 *    sent to each worker once.
 *  - `createCompilerWorker`: runs the whole compileFirmware inside a worker and talks to it by
 *    messages, so the page never blocks.
 */
import type { CompileOptions, ToolExecutor } from "./compile";
import { filesetId, type LoadedTool, type RunOptions, type RunResult } from "./driver";
import type { CompileProgress, CompileRequest, CompileResponse } from "./types";

export type WorkerUrl = string | URL;

/** Messages main → worker. */
export type ToWorker =
    | {
          type: "run";
          id: number;
          tool: { id: string; name: string; js?: string; module?: WebAssembly.Module };
          argv: string[];
          files: Array<{ id?: string; entries?: Array<[string, Uint8Array]> }>;
          cwd: string;
          mkdirs?: string[];
          thisProgram: string;
          outputs?: string[];
          env?: Record<string, string>;
      }
    | { type: "compile"; id: number; request: CompileRequest; options: WorkerCompileOptions }
    | { type: "prewarm"; id: number; board: string; options: WorkerCompileOptions };

/** Messages worker → main. */
export type FromWorker =
    | { type: "result"; id: number; result: RunResult }
    | { type: "progress"; id: number; progress: CompileProgress }
    | { type: "done"; id: number; response: CompileResponse }
    | { type: "error"; id: number; message: string };

/** The serialisable part of CompileOptions (+ the pool size for parallel TUs). */
export interface WorkerCompileOptions {
    packBaseUrl: string;
    /** Host route to the PlatformIO registry (see CompileOptions.registryBase), e.g. "/firmware-libs/". */
    registryBase?: string;
    usePch?: boolean;
    cache?: boolean;
    cacheStorage?: boolean;
    /** Nested workers for parallel TUs (0 = inline). Default: min(4, hardwareConcurrency - 1). */
    poolSize?: number;
}

interface PoolWorker {
    w: Worker;
    busy: boolean;
    tools: Set<string>;
    filesets: Set<string>;
}

export interface WorkerPool extends ToolExecutor {
    size: number;
    terminate(): void;
}

export function createWorkerPool(url: WorkerUrl, size: number): WorkerPool {
    const workers: PoolWorker[] = [];
    const waiting: Array<(w: PoolWorker) => void> = [];
    const pending = new Map<number, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>();
    let seq = 0;
    const spawn = () => {
        const w = new Worker(url, { type: "module" });
        const pw: PoolWorker = { w, busy: false, tools: new Set(), filesets: new Set() };
        w.onmessage = (ev: MessageEvent<FromWorker>) => {
            const m = ev.data;
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.type === "result") p.resolve(m.result);
            else if (m.type === "error") p.reject(new Error(m.message));
            release(pw);
        };
        workers.push(pw);
        return pw;
    };
    const release = (pw: PoolWorker) => {
        pw.busy = false;
        const next = waiting.shift();
        if (next) {
            pw.busy = true;
            next(pw);
        }
    };
    const acquire = (): Promise<PoolWorker> => {
        const idle = workers.find((x) => !x.busy) ?? (workers.length < size ? spawn() : undefined);
        if (idle) {
            idle.busy = true;
            return Promise.resolve(idle);
        }
        return new Promise((r) => waiting.push(r));
    };
    return {
        size,
        async run(tool: LoadedTool, argv: string[], opts: RunOptions): Promise<RunResult> {
            const pw = await acquire();
            const id = ++seq;
            const toolId = tool.id ?? tool.name;
            const sets = Array.isArray(opts.files) ? opts.files : [opts.files];
            const files = sets.map((set) => {
                const fid = filesetId(set);
                if (fid && pw.filesets.has(fid)) return { id: fid };
                if (fid) pw.filesets.add(fid);
                return { ...(fid ? { id: fid } : {}), entries: [...set] };
            });
            const msg: ToWorker = {
                type: "run",
                id,
                tool: pw.tools.has(toolId) ? { id: toolId, name: tool.name } : { id: toolId, name: tool.name, js: tool.js, module: tool.module },
                argv,
                files,
                cwd: opts.cwd,
                mkdirs: opts.mkdirs,
                thisProgram: opts.thisProgram,
                outputs: opts.outputs,
                env: opts.env,
            };
            pw.tools.add(toolId);
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                pw.w.postMessage(msg);
            });
        },
        terminate() {
            for (const pw of workers) pw.w.terminate();
            workers.length = 0;
        },
    };
}

/** compileFirmware in a dedicated worker. */
export interface CompilerWorker {
    compile(request: CompileRequest, opts: Pick<CompileOptions, "onProgress"> & WorkerCompileOptions): Promise<CompileResponse>;
    prewarm(board: string, opts: Pick<CompileOptions, "onProgress"> & WorkerCompileOptions): Promise<void>;
    terminate(): void;
}

export function createCompilerWorker(url: WorkerUrl): CompilerWorker {
    const w = new Worker(url, { type: "module" });
    const pending = new Map<number, { resolve: (r: CompileResponse) => void; reject: (e: Error) => void; onProgress?: (p: CompileProgress) => void }>();
    let seq = 0;
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        const p = pending.get(m.id);
        if (!p) return;
        if (m.type === "progress") return p.onProgress?.(m.progress);
        pending.delete(m.id);
        if (m.type === "done") p.resolve(m.response);
        else if (m.type === "error") p.reject(new Error(m.message));
    };
    const call = (msg: ToWorker, onProgress?: (p: CompileProgress) => void) =>
        new Promise<CompileResponse>((resolve, reject) => {
            pending.set(msg.id, { resolve, reject, onProgress });
            w.postMessage(msg);
        });
    const strip = <T extends { onProgress?: unknown }>(o: T) => {
        const { onProgress: _p, ...rest } = o;
        return rest as Omit<T, "onProgress">;
    };
    return {
        compile: (request, opts) => call({ type: "compile", id: ++seq, request, options: strip(opts) }, opts.onProgress),
        prewarm: async (board, opts) => {
            await call({ type: "prewarm", id: ++seq, board, options: strip(opts) }, opts.onProgress);
        },
        terminate: () => w.terminate(),
    };
}
