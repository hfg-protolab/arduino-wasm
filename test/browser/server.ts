/**
 * Headless-Chrome benchmark of compileFirmware in a Web Worker, packs over HTTP.
 *
 *   bun test/browser/server.ts [--pack .build/packs/<v>] [--port 8765] [--cases uno:blink,esp32dev:wifi]
 *                              [--chrome <path>] [--no-br]
 *
 * Serves the harness page, the bundled worker and the pack (Brotli-encoded like a CDN would,
 * Cache-Control immutable), starts Chrome with a fresh profile, runs the "cold" stage (empty
 * caches), then reloads for the "reload" stage (Cache Storage + code cache warm), prints a table
 * and checks the images against a Node compile of the same sketches.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { loadConfig, REPO } from "../../pack/common.ts";
import { sketchFiles } from "../reference-build.ts";

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1]! : d;
};
const cfg = loadConfig();
const PACK = arg("--pack", join(REPO, ".build/packs", cfg.packVersion))!;
const port = Number(arg("--port", "8765"));
const chrome = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")!;
const useBr = !args.includes("--no-br");
const cases = (arg("--cases", "uno:blink,uno:oled_uno,uno:multi,esp32dev:blink,esp32dev:wifi") ?? "")
    .split(",")
    .map((x) => x.split(":") as [string, string])
    .filter(([b]) => existsSync(join(PACK, "boards", `${b}.json`)))
    .map(([board, sketch]) => ({ board, sketch, files: sketchFiles(sketch) }));

const work = join(REPO, ".build/test-work/browser");
mkdirSync(work, { recursive: true });
const built = await Bun.build({ entrypoints: [join(REPO, "src/worker.ts"), join(REPO, "test/browser/harness.ts")], target: "browser", format: "esm", outdir: work, naming: "[name].js" });
if (!built.success) throw new Error(built.logs.join("\n"));

// Brotli per file, cached on disk (quality 9: close to q11, much faster on 12 MB wasm).
const brDir = join(REPO, ".build/test-work/br-cache");
mkdirSync(brDir, { recursive: true });
function brotliOf(path: string, key: string): Buffer {
    const p = join(brDir, key + ".br");
    if (existsSync(p)) return readFileSync(p);
    const b = brotliCompressSync(readFileSync(path), { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24 } });
    writeFileSync(p, b);
    return b;
}
// Precompress up front so the cold timings do not include server-side compression.
if (useBr) {
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(join(PACK, "files"))) if (!f.endsWith(".o")) brotliOf(join(PACK, "files", f), f);
}

let sent = 0;
let requests = 0;
let stage: "cold" | "reload" = "cold";
const out: Record<string, unknown> = {};
let chromeProc: ReturnType<typeof spawn> | undefined;
const type = (p: string) => (p.endsWith(".wasm") ? "application/wasm" : p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : p.endsWith(".html") ? "text/html" : "application/octet-stream");

const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const p = url.pathname;
    if (p === "/" || p === "/index.html") {
        res.setHeader("content-type", "text/html");
        return res.end(`<!doctype html><meta charset="utf-8"><title>arduino-wasm bench</title><pre id="log"></pre><script type="module" src="/harness.js"></script>`);
    }
    if (p === "/harness.js" || p === "/worker.js") {
        res.setHeader("content-type", "text/javascript");
        return res.end(readFileSync(join(work, p.slice(1))));
    }
    if (p === "/job.json") return res.end(JSON.stringify({ cases, stage }));
    if (p === "/bytes") return res.end(JSON.stringify({ sent, requests }));
    if (p.startsWith("/pack/")) {
        const rel = decodeURIComponent(p.slice(6));
        const f = join(PACK, rel);
        if (rel.includes("..") || !existsSync(f)) return res.writeHead(404).end();
        requests++;
        res.setHeader("content-type", type(f));
        res.setHeader("cache-control", rel.startsWith("files/") ? "public, max-age=31536000, immutable" : "no-cache");
        let body: Buffer;
        if (useBr && /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
            // content-addressed files by name; the rest (index, manifests) by content
            body = brotliOf(f, rel.startsWith("files/") ? rel.slice(6) : createHash("sha256").update(readFileSync(f)).digest("hex"));
            res.setHeader("content-encoding", "br");
        } else body = readFileSync(f);
        sent += body.length;
        return res.end(body);
    }
    if (p === "/result" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            res.end("ok");
            const r = JSON.parse(body);
            out[stage] = r;
            if (r.error) {
                console.error(r.error);
                finish(1);
                return;
            }
            if (stage === "cold") {
                stage = "reload";
                // same profile, new page: Cache Storage + HTTP cache + code cache stay
                chromeProc?.kill();
                setTimeout(() => startChrome(false), 500);
            } else finish(0);
        });
        return;
    }
    res.writeHead(404).end();
});

const profile = join(work, "chrome-profile");
function startChrome(fresh: boolean) {
    if (fresh) rmSync(profile, { recursive: true, force: true });
    chromeProc = spawn(chrome, ["--headless=new", "--no-first-run", "--disable-gpu", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `http://127.0.0.1:${port}/`], { stdio: "ignore" });
}

/** The images Chrome produced must equal a Node/Bun compile of the same sketch. */
async function verify(): Promise<string[]> {
    const { compileFirmware } = await import("../../src/compile.ts");
    const { diskFetch, PACK_BASE } = await import("../node-fetch.ts");
    const lines: string[] = [];
    const cold = out.cold as { results?: Array<Record<string, any>> } | undefined;
    for (const x of cold?.results ?? []) {
        if (x.label !== "cold" || !x.ok) continue;
        const c = cases.find((k) => k.board === x.board && k.sketch === x.sketch)!;
        const r = await compileFirmware({ board: c.board, files: c.files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), cacheStorage: false });
        const same = r.files.length === x.files.length && r.files.every((f) => {
            const b = x.files.find((y: any) => y.name === f.name);
            return b && Buffer.from(b.b64, "base64").equals(Buffer.from(f.data)) && b.address === f.address;
        });
        lines.push(`${c.board} ${c.sketch}: Chrome images ${same ? "==" : "!="} Node images`);
    }
    return lines;
}

async function finish(code: number) {
    chromeProc?.kill();
    if (code === 0) for (const l of await verify()) console.log(l);
    writeFileSync(join(work, "result.json"), JSON.stringify(out, null, 1));
    const rows: string[] = [];
    for (const st of ["cold", "reload"] as const) {
        const r = out[st] as { results?: Array<Record<string, any>>; userAgent?: string } | undefined;
        if (!r?.results) continue;
        if (st === "cold") rows.push(`Chrome: ${r.userAgent}`);
        for (const x of r.results) {
            rows.push(
                `${x.board.padEnd(9)} ${x.sketch.padEnd(9)} ${x.label.padEnd(17)} ok=${x.ok} ${String(x.ms).padStart(6)} ms  wire ${(x.wireBytes / 1e6).toFixed(2).padStart(6)} MB (${x.requests} req)  phases ${JSON.stringify(x.stats?.phases)}  members ${JSON.stringify(x.stats?.members ?? null)}`,
            );
        }
    }
    console.log(rows.join("\n"));
    server.close();
    process.exit(code);
}

server.listen(port, "127.0.0.1", () => {
    console.log(`serving ${PACK} on http://127.0.0.1:${port}/ (brotli: ${useBr}); ${cases.length} cases`);
    startChrome(true);
    setTimeout(() => {
        console.error("timeout");
        finish(1);
    }, 900_000);
});
