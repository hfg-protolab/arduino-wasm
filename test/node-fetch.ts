/** A `fetch` that serves a pack directory from disk (tests, benchmarks; Node/Bun only). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACK_BASE = "http://pack.local/";

export function diskFetch(dir: string, counter?: { bytes: number; requests: number }) {
    return async (url: string): Promise<Response> => {
        const rel = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
        const p = join(dir, rel);
        if (!existsSync(p)) return new Response("not found", { status: 404 });
        const data = readFileSync(p);
        if (counter) {
            counter.bytes += data.length;
            counter.requests++;
        }
        const type = p.endsWith(".wasm") ? "application/wasm" : p.endsWith(".json") ? "application/json" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream";
        return new Response(data, { headers: { "content-type": type } });
    };
}
