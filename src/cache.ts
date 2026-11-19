/**
 * Caching levels of plan decision 11:
 *  (a) pack files are content-addressed and immutable (the host sets Cache-Control);
 *  (b) Cache Storage (when available) keeps every fetched pack file, so a second visit and
 *      offline use need no network;
 *  (c) tools are compiled with WebAssembly.compileStreaming from the network/Cache Storage
 *      response, so Chrome can reuse its compiled code; compiled modules are kept per runtime;
 *  (d) object cache per translation unit, keyed by sha256(pack version, board, argv, sources).
 * Browser-safe.
 */
import type { FileRef } from "./manifest";

export const CACHE_NAME = "arduino-wasm-packs-v1";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface StoreOptions {
    fetch?: Fetch;
    /** Use Cache Storage (`caches`) when the environment has it. Default true. */
    cacheStorage?: boolean;
}

/** Fetches pack files once, with byte counting for progress, through Cache Storage. */
export class PackStore {
    readonly baseUrl: string;
    private fetchFn: Fetch;
    private useCaches: boolean;
    private bytes = new Map<string, Promise<Uint8Array>>();
    private jsonCache = new Map<string, Promise<unknown>>();
    /** Bytes that came over the network since construction. */
    downloaded = 0;

    constructor(baseUrl: string, opts: StoreOptions = {}) {
        let base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
        // A relative base ("/pack/") resolves against the page/worker location.
        const here = (globalThis as { location?: { href: string } }).location?.href;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(base) && here) base = new URL(base, here).toString();
        this.baseUrl = base;
        this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
        this.useCaches = (opts.cacheStorage ?? true) && typeof caches !== "undefined";
    }

    url(file: string): string {
        return new URL(file, this.baseUrl).toString();
    }

    has(ref: FileRef): boolean {
        return this.bytes.has(ref.sha256);
    }

    private async open(file: string): Promise<{ res: Response; network: boolean }> {
        const url = this.url(file);
        if (this.useCaches) {
            try {
                const c = await caches.open(CACHE_NAME);
                const hit = await c.match(url);
                if (hit) return { res: hit, network: false };
            } catch {
                /* Cache Storage unavailable (opaque origin, quota) */
            }
        }
        const res = await this.fetchFn(url);
        if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
        return { res, network: true };
    }

    private async remember(file: string, data: Uint8Array, type: string) {
        if (!this.useCaches) return;
        try {
            const c = await caches.open(CACHE_NAME);
            await c.put(this.url(file), new Response(data as BodyInit, { headers: { "content-type": type } }));
        } catch {
            /* best effort */
        }
    }

    /** Small JSON file (index, manifests, link index); not content-addressed paths are fine. */
    json<T>(file: string): Promise<T> {
        let p = this.jsonCache.get(file);
        if (!p) {
            p = (async () => {
                const { res } = await this.open(file);
                return res.json();
            })();
            p.catch(() => this.jsonCache.delete(file));
            this.jsonCache.set(file, p);
        }
        return p as Promise<T>;
    }

    /** File bytes; `onBytes` sees every chunk that arrives over the network or from Cache Storage. */
    get(ref: FileRef, onBytes?: (n: number) => void): Promise<Uint8Array> {
        let p = this.bytes.get(ref.sha256);
        if (!p) {
            p = (async () => {
                const { res, network } = await this.open(ref.file);
                const data = await readCounting(res, ref.size, (n) => {
                    if (network) this.downloaded += n;
                    onBytes?.(n);
                });
                if (network) void this.remember(ref.file, data, res.headers.get("content-type") ?? "application/octet-stream");
                return data;
            })();
            p.catch(() => this.bytes.delete(ref.sha256));
            this.bytes.set(ref.sha256, p);
        } else if (onBytes) void p.then(() => undefined);
        return p;
    }

    /**
     * A wasm module, compiled with compileStreaming from the network/Cache Storage response
     * (Chrome then caches the compiled code itself); bytes are counted on a tee'd copy, which
     * also goes into Cache Storage.
     */
    async wasm(ref: FileRef, onBytes?: (n: number) => void): Promise<WebAssembly.Module> {
        const { res, network } = await this.open(ref.file);
        const streaming = typeof WebAssembly.compileStreaming === "function" && res.body && res.headers.get("content-type")?.startsWith("application/wasm");
        if (!streaming || !res.body) {
            const data = await readCounting(res, ref.size, (n) => {
                if (network) this.downloaded += n;
                onBytes?.(n);
            });
            if (network) void this.remember(ref.file, data, "application/wasm");
            return WebAssembly.compile(data as BufferSource);
        }
        const copy = res.clone();
        const counted = readCounting(copy, ref.size, (n) => {
            if (network) this.downloaded += n;
            onBytes?.(n);
        }).then((data) => {
            if (network) void this.remember(ref.file, data, "application/wasm");
        });
        const [mod] = await Promise.all([WebAssembly.compileStreaming(res), counted]);
        return mod;
    }
}

async function readCounting(res: Response, expected: number, onBytes: (n: number) => void): Promise<Uint8Array> {
    if (!res.body) {
        const b = new Uint8Array(await res.arrayBuffer());
        onBytes(b.length);
        return b;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        onBytes(value.length);
    }
    if (chunks.length === 1 && chunks[0]!.length === total) return chunks[0]!;
    const out = new Uint8Array(Math.max(total, 0));
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    void expected;
    return out;
}

/** Object cache (d): bounded in-memory map, least recently used out first. */
export class ObjectCache {
    private map = new Map<string, Uint8Array>();
    private bytes = 0;
    constructor(private maxBytes = 64 * 1024 * 1024) {}
    get(key: string): Uint8Array | undefined {
        const v = this.map.get(key);
        if (v) {
            this.map.delete(key);
            this.map.set(key, v);
        }
        return v;
    }
    set(key: string, v: Uint8Array) {
        if (this.map.has(key)) return;
        this.map.set(key, v);
        this.bytes += v.length;
        for (const [k, old] of this.map) {
            if (this.bytes <= this.maxBytes) break;
            this.map.delete(k);
            this.bytes -= old.length;
        }
    }
    clear() {
        this.map.clear();
        this.bytes = 0;
    }
}

export async function sha256Hex(parts: Array<string | Uint8Array>): Promise<string> {
    const enc = new TextEncoder();
    const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
    let len = 0;
    for (const c of chunks) len += 4 + c.length;
    const buf = new Uint8Array(len);
    const dv = new DataView(buf.buffer);
    let o = 0;
    for (const c of chunks) {
        dv.setUint32(o, c.length, true);
        buf.set(c, o + 4);
        o += 4 + c.length;
    }
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
