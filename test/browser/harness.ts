/**
 * Browser harness page script (bundled by server.ts): compileFirmware in a Web Worker
 * (src/worker.ts) with the pack over HTTP. Measures per board: cold (empty caches: download +
 * wasm compile + compile), warm (same worker, object cache off), recompile (object cache on), and
 * after a reload (Cache Storage + Chrome's wasm code cache, new worker).
 */
import { createCompilerWorker } from "../../src/pool";
import type { CompileProgress } from "../../src/types";

interface Case {
    board: string;
    sketch: string;
    files: Array<{ path: string; content: string }>;
}

const log = (s: string) => {
    document.getElementById("log")!.textContent += s + "\n";
};

async function main() {
    const job = (await (await fetch("/job.json")).json()) as { cases: Case[]; stage: "cold" | "reload" };
    const w = createCompilerWorker("/worker.js");
    const results: unknown[] = [];
    const bytes = async () => (await (await fetch("/bytes")).json()) as { sent: number; requests: number };
    for (const c of job.cases) {
        const files = c.files;
        const progress: CompileProgress[] = [];
        const run = async (label: string, cache: boolean) => {
            const b0 = await bytes();
            const t = performance.now();
            const r = await w.compile({ board: c.board, files }, { packBaseUrl: "/pack/", cache, onProgress: (p) => progress.push(p) });
            const ms = performance.now() - t;
            const b1 = await bytes();
            const row = {
                board: c.board,
                sketch: c.sketch,
                label,
                ok: r.ok,
                ms: Math.round(ms),
                wireBytes: b1.sent - b0.sent - 0,
                requests: b1.requests - b0.requests,
                stats: r.stats,
                size: r.size,
                errors: r.errors.slice(0, 3),
                files: r.files.map((f) => ({ name: f.name, address: f.address, bytes: f.data.length, b64: label === "cold" || label === "reload" ? btoa(Array.from(f.data, (x) => String.fromCharCode(x)).join("")) : undefined })),
            };
            log(JSON.stringify({ ...row, files: undefined }));
            results.push(row);
        };
        if (job.stage === "cold") {
            await run("cold", false);
            await run("warm", false);
            await run("warm", false);
            await run("fill-object-cache", true);
            await run("recompile-cached", true);
        } else {
            await run("reload", false);
            await run("warm", false);
        }
        void progress;
    }
    w.terminate();
    await fetch("/result", { method: "POST", body: JSON.stringify({ stage: job.stage, userAgent: navigator.userAgent, results }) });
}

main().catch(async (e) => {
    log(String(e?.stack ?? e));
    await fetch("/result", { method: "POST", body: JSON.stringify({ error: String(e?.stack ?? e) }) });
});
