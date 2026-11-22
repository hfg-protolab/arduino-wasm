/**
 * PlatformIO registry access (API v3) for the browser and Node.
 *
 * With `registryBase` (e.g. "/firmware-libs/") everything goes through the host:
 *   metadata  `${registryBase}api/v3/<path>?<query>`   (a pass-through to api.registry.platformio.org/v3)
 *   downloads `${registryBase}dl/<sha256>?url=<encodeURIComponent(download_url)>` (the .tar.gz bytes)
 * Without it, the API is called directly and downloads follow the registry's redirect (works in
 * Node; browsers fail on the redirect's duplicated CORS header, hence the host route).
 *
 * Tarballs are content-addressed (sha256 from the API, verified) and kept in Cache Storage.
 */
import { sha256Hex } from "./tar";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const REGISTRY_API = "https://api.registry.platformio.org/v3/";
export const TARBALL_CACHE = "arduino-wasm-registry-v1";

export interface RegistryFile {
    name: string;
    size: number;
    checksum: { sha256: string };
    system?: string | string[];
    download_url: string;
}

export interface RegistryVersion {
    name: string;
    files: RegistryFile[];
    released_at?: string;
    unpacked_size?: number;
}

export interface RegistryPackage {
    id: number;
    type: string;
    owner: { username: string };
    name: string;
    description?: string;
    headers?: string[];
    frameworks?: Array<string | { name: string }>;
    platforms?: Array<string | { name: string }>;
    popularity_rank?: number;
    version: RegistryVersion;
    versions?: RegistryVersion[];
}

export interface RegistrySearchItem {
    id: number;
    owner: { username: string };
    name: string;
    description?: string;
    license?: string | null;
    popularity_rank?: number;
    stars_count?: number;
    updated_at?: string;
    keywords?: string[];
    version: RegistryVersion;
}

/** The registry (or the host's route to it) did not answer. */
export class RegistryUnreachableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RegistryUnreachableError";
    }
}

export interface RegistryClientOptions {
    registryBase?: string;
    fetch?: Fetch;
    /** Keep tarballs in Cache Storage (default: when available). */
    cacheStorage?: boolean;
}

function resolveBase(base: string): string {
    let b = base.endsWith("/") ? base : `${base}/`;
    const here = (globalThis as { location?: { href: string } }).location?.href;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(b) && here) b = new URL(b, here).toString();
    return b;
}

export class RegistryClient {
    readonly base: string | null;
    private fetchFn: Fetch;
    private useCaches: boolean;
    private json = new Map<string, Promise<unknown>>();
    private tarballs = new Map<string, Promise<Uint8Array>>();
    /** Bytes downloaded over the network (tarballs). */
    downloaded = 0;

    constructor(opts: RegistryClientOptions = {}) {
        this.base = opts.registryBase ? resolveBase(opts.registryBase) : null;
        this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
        this.useCaches = (opts.cacheStorage ?? true) && typeof caches !== "undefined";
    }

    apiUrl(path: string, query?: Record<string, string>): string {
        const q = query ? new URLSearchParams(query).toString() : "";
        const root = this.base ? `${this.base}api/v3/` : REGISTRY_API;
        return `${root}${path}${q ? `?${q}` : ""}`;
    }

    downloadUrl(file: RegistryFile): string {
        if (this.base) return `${this.base}dl/${file.checksum.sha256}?url=${encodeURIComponent(file.download_url)}`;
        return file.download_url;
    }

    private async getJson<T>(url: string, allow404 = false): Promise<T | null> {
        let p = this.json.get(url);
        if (!p) {
            p = (async () => {
                let res: Response;
                try {
                    res = await this.fetchFn(url, { headers: { accept: "application/json" } });
                } catch (e) {
                    throw new RegistryUnreachableError(`registry unreachable: ${(e as Error).message}`);
                }
                if (res.status === 404 && allow404) return null;
                if (!res.ok) {
                    if (res.status >= 500 || res.status === 429 || res.status === 403) throw new RegistryUnreachableError(`registry unreachable: HTTP ${res.status} for ${url}`);
                    throw new Error(`registry: HTTP ${res.status} for ${url}`);
                }
                return res.json();
            })();
            p.catch(() => this.json.delete(url));
            this.json.set(url, p);
        }
        return p as Promise<T | null>;
    }

    /** `/v3/packages/<owner>/library/<name>` (owner and name lower-cased, like PlatformIO); null when unknown. */
    getPackage(owner: string, name: string): Promise<RegistryPackage | null> {
        return this.getJson<RegistryPackage>(this.apiUrl(`packages/${encodeURIComponent(owner.toLowerCase())}/library/${encodeURIComponent(name.toLowerCase())}`), true);
    }

    /** `/v3/search?query=…` (PlatformIO's query syntax: `name:"x" owner:"y" header:"z.h" framework:"arduino" platform:"atmelavr"`). */
    async search(query: string, opts: { page?: number; sort?: string } = {}): Promise<{ total: number; items: RegistrySearchItem[] }> {
        const q: Record<string, string> = { query };
        if (opts.page) q.page = String(opts.page);
        if (opts.sort) q.sort = opts.sort;
        const r = await this.getJson<{ total: number; items: RegistrySearchItem[] }>(this.apiUrl("search", q));
        return r ?? { total: 0, items: [] };
    }

    /** A package tarball: Cache Storage, else the network; the sha256 is checked either way. */
    tarball(file: RegistryFile, onBytes?: (n: number) => void): Promise<Uint8Array> {
        const sha = file.checksum.sha256.toLowerCase();
        let p = this.tarballs.get(sha);
        if (!p) {
            p = this.loadTarball(file, sha, onBytes);
            p.catch(() => this.tarballs.delete(sha));
            this.tarballs.set(sha, p);
        }
        return p;
    }

    private cacheKey = (sha: string) => `https://arduino-wasm.invalid/registry/${sha}.tar.gz`;

    private async loadTarball(file: RegistryFile, sha: string, onBytes?: (n: number) => void): Promise<Uint8Array> {
        if (this.useCaches) {
            try {
                const c = await caches.open(TARBALL_CACHE);
                const hit = await c.match(this.cacheKey(sha));
                if (hit) {
                    const data = new Uint8Array(await hit.arrayBuffer());
                    if ((await sha256Hex(data)) === sha) return data;
                }
            } catch {
                /* Cache Storage unavailable */
            }
        }
        const url = this.downloadUrl(file);
        let res: Response;
        try {
            res = await this.fetchFn(url);
        } catch (e) {
            throw new RegistryUnreachableError(`registry unreachable: ${(e as Error).message}`);
        }
        if (!res.ok) throw new RegistryUnreachableError(`registry unreachable: HTTP ${res.status} for ${file.name}`);
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.length;
                this.downloaded += value.length;
                onBytes?.(value.length);
            }
        } else {
            const b = new Uint8Array(await res.arrayBuffer());
            chunks.push(b);
            total = b.length;
            this.downloaded += b.length;
            onBytes?.(b.length);
        }
        const data = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
            data.set(c, o);
            o += c.length;
        }
        const got = await sha256Hex(data);
        if (got !== sha) throw new Error(`${file.name}: sha256 mismatch (expected ${sha}, got ${got})`);
        if (this.useCaches) {
            try {
                const c = await caches.open(TARBALL_CACHE);
                await c.put(this.cacheKey(sha), new Response(data as BodyInit, { headers: { "content-type": "application/gzip" } }));
            } catch {
                /* best effort */
            }
        }
        return data;
    }
}

const clients = new Map<string, RegistryClient>();
/** One client (and its caches) per registry base. */
export function registryClient(opts: RegistryClientOptions = {}): RegistryClient {
    const key = `${opts.registryBase ?? ""}|${opts.cacheStorage ?? ""}|${opts.fetch ? "f" : ""}`;
    let c = clients.get(key);
    if (!c || opts.fetch) {
        c = new RegistryClient(opts);
        if (!opts.fetch) clients.set(key, c);
    }
    return c;
}

export interface LibrarySearchResult {
    owner: string;
    name: string;
    version: string;
    description: string;
    license: string | null;
    popularityRank: number | null;
    stars: number;
    updatedAt: string | null;
    keywords: string[];
    /** "owner/Name@^version" for lib_deps. */
    spec: string;
}

const q = (s: string) => `"${s.replace(/"/g, "")}"`;

/**
 * Registry search for a library dialog: framework arduino and the board's platform
 * (`atmelavr`, `espressif32`, `espressif8266`; `manifest.registry.platform`).
 */
export async function searchLibraries(
    registryBase: string | undefined,
    query: string,
    opts: { platform?: string; framework?: string; page?: number; sort?: string; fetch?: Fetch } = {},
): Promise<{ total: number; items: LibrarySearchResult[] }> {
    const client = registryClient({ registryBase, fetch: opts.fetch });
    const parts = [`type:"library"`, `framework:${q(opts.framework ?? "arduino")}`];
    if (opts.platform) parts.push(`platform:${q(opts.platform)}`);
    if (query.trim()) parts.push(query.trim());
    const r = await client.search(parts.join(" "), { page: opts.page, sort: opts.sort });
    return {
        total: r.total,
        items: r.items.map((it) => ({
            owner: it.owner.username,
            name: it.name,
            version: it.version.name,
            description: it.description ?? "",
            license: it.license ?? null,
            popularityRank: it.popularity_rank ?? null,
            stars: it.stars_count ?? 0,
            updatedAt: it.updated_at ?? null,
            keywords: it.keywords ?? [],
            spec: `${it.owner.username}/${it.name}@^${it.version.name}`,
        })),
    };
}

export interface HeaderSuggestion {
    owner: string;
    name: string;
    version: string;
    description: string;
}

/** Up to `limit` registry libraries that ship `header` (PlatformIO's `header:"X.h"` search qualifier). */
export async function suggestForHeader(client: RegistryClient, header: string, opts: { platform: string; framework: string; limit?: number }): Promise<HeaderSuggestion[]> {
    const r = await client.search(`type:"library" header:${q(header)} framework:${q(opts.framework)} platform:${q(opts.platform)}`);
    return r.items.slice(0, opts.limit ?? 3).map((it) => ({ owner: it.owner.username, name: it.name, version: it.version.name, description: it.description ?? "" }));
}
