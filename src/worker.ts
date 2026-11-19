/**
 * Web Worker entry (bundle it, e.g. `bun build src/worker.ts --target browser`). One script,
 * two roles, chosen per message:
 *
 *  - "compile" / "prewarm": runs compileFirmware/prewarm here (dedicated compiler worker,
 *    pool.ts createCompilerWorker). Multi-file sketches use a nested pool of this same script.
 *  - "run": runs one tool invocation (pool worker, pool.ts createWorkerPool).
 */
import { compileFirmware, prewarm, type ToolExecutor } from "./compile";
import { factoryFromSource, runTool, type LoadedTool } from "./driver";
import { createWorkerPool, type FromWorker, type ToWorker, type WorkerCompileOptions } from "./pool";

// Minimal worker-scope typing (the project compiles against the DOM lib).
declare const self: { location: { href: string }; postMessage(m: unknown): void; onmessage: ((ev: MessageEvent<ToWorker>) => void) | null };
declare const WorkerGlobalScope: unknown;

const tools = new Map<string, LoadedTool>();
const filesets = new Map<string, Map<string, Uint8Array>>();
let pool: (ToolExecutor & { size: number }) | undefined;

const post = (m: FromWorker) => self.postMessage(m);

function poolFor(o: WorkerCompileOptions): ToolExecutor | undefined {
    const hc = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 2) : 2;
    const size = o.poolSize ?? Math.min(4, Math.max(0, hc - 1));
    if (size < 2) return undefined;
    if (!pool || pool.size !== size) pool = createWorkerPool(self.location.href, size);
    return pool;
}

async function handle(m: ToWorker) {
    if (m.type === "run") {
        let tool = tools.get(m.tool.id);
        if (!tool) {
            if (!m.tool.js || !m.tool.module) throw new Error(`tool ${m.tool.id} not loaded in this worker`);
            tool = { id: m.tool.id, name: m.tool.name, js: m.tool.js, module: m.tool.module, factory: factoryFromSource(m.tool.js) };
            tools.set(m.tool.id, tool);
        }
        const files = m.files.map((f) => {
            if (f.entries) {
                const map = new Map(f.entries);
                if (f.id) filesets.set(f.id, map);
                return map;
            }
            const map = f.id ? filesets.get(f.id) : undefined;
            if (!map) throw new Error(`file set ${f.id} unknown in this worker`);
            return map;
        });
        const result = await runTool(tool, m.argv, { files, cwd: m.cwd, mkdirs: m.mkdirs, thisProgram: m.thisProgram, outputs: m.outputs });
        post({ type: "result", id: m.id, result });
        return;
    }
    const onProgress = (progress: Parameters<NonNullable<Parameters<typeof prewarm>[1]["onProgress"]>>[0]) => post({ type: "progress", id: m.id, progress });
    const opts = { ...m.options, onProgress, executor: poolFor(m.options) };
    if (m.type === "compile") {
        const response = await compileFirmware(m.request, opts);
        post({ type: "done", id: m.id, response });
    } else {
        await prewarm(m.board, opts);
        post({ type: "done", id: m.id, response: { ok: true, board: m.board, errors: [], warnings: [], files: [], log: "", durationMs: 0 } });
    }
}

if (typeof WorkerGlobalScope !== "undefined") {
    self.onmessage = (ev: MessageEvent<ToWorker>) => {
        handle(ev.data).catch((e: unknown) => post({ type: "error", id: ev.data.id, message: String((e as Error)?.stack ?? e) }));
    };
}
