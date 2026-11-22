/**
 * Registry corpus: the most popular Arduino libraries of the PlatformIO registry
 * (`popularity_rank`), each example of each library as a sketch with `lib_deps =
 * owner/Name@<version>` in platformio.ini (the native reference gets the same line).
 *
 *   bun test/corpus/registry.ts [--top 30] [--refresh]   # writes .build/corpus-registry/list.json + tarballs
 *
 * The list is pinned (versions, sha256) so reruns compare the same thing; the corpus reads it
 * from disk (no network at load time).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../../pack/common.ts";
import { RegistryClient } from "../../src/registry/client";
import { unpackPackage } from "../../src/registry/resolve";

export const REGISTRY_CORPUS = process.env.CORPUS_REGISTRY ?? join(REPO, ".build/corpus-registry");

export interface RegistryCorpusLib {
    owner: string;
    name: string;
    version: string;
    rank: number;
    platforms: string[];
    /** example id → files */
    examples: Array<{ id: string; files: Array<{ path: string; content: string }> }>;
}

const SRC_RE = /\.(ino|pde|cpp|c|h|hpp)$/;

/** Sketch dirs (dir/<basename>.ino|.pde) below examples/ in a package's file map, with their files (not nested sketches). */
function examplesOf(files: Map<string, Uint8Array>): RegistryCorpusLib["examples"] {
    const dec = new TextDecoder();
    const sketchDirs = new Set<string>();
    for (const p of files.keys()) {
        const m = /^(?:examples|Examples)\/(.+)\/([^/]+)\.(ino|pde)$/.exec(p);
        if (m && m[1]!.split("/").pop() === m[2]) sketchDirs.add(p.slice(0, p.lastIndexOf("/")));
    }
    const out: RegistryCorpusLib["examples"] = [];
    for (const d of [...sketchDirs].sort()) {
        const fs: Array<{ path: string; content: string }> = [];
        for (const [p, data] of files) {
            if (!p.startsWith(`${d}/`) || !SRC_RE.test(p)) continue;
            const rel = p.slice(d.length + 1);
            const parts = rel.split("/");
            // a nested sketch dir is its own example
            if (parts.slice(0, -1).some((_, i) => sketchDirs.has(`${d}/${parts.slice(0, i + 1).join("/")}`))) continue;
            fs.push({ path: rel, content: dec.decode(data) });
        }
        out.push({ id: d.replace(/^(examples|Examples)\//, ""), files: fs.sort((a, b) => (a.path < b.path ? -1 : 1)) });
    }
    return out;
}

export function loadRegistryCorpus(): RegistryCorpusLib[] {
    const p = join(REGISTRY_CORPUS, "list.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

async function main() {
    const args = process.argv.slice(2);
    const top = Number(args[args.indexOf("--top") + 1] ?? 30) || 30;
    mkdirSync(REGISTRY_CORPUS, { recursive: true });
    const client = new RegistryClient({ cacheStorage: false });
    const libs: RegistryCorpusLib[] = [];
    for (let page = 1; libs.length < top && page < 40; page++) {
        const r = await client.search(`type:"library" framework:"arduino"`, { page, sort: "popularity" });
        if (!r.items.length) break;
        for (const it of r.items) {
            if (libs.length >= top) break;
            const pkg = await client.getPackage(it.owner.username, it.name);
            if (!pkg) continue;
            const file = pkg.version.files[0]!;
            const cache = join(REGISTRY_CORPUS, `${file.checksum.sha256}.tar.gz`);
            const tgz = existsSync(cache) ? new Uint8Array(readFileSync(cache)) : await client.tarball(file);
            writeFileSync(cache, tgz);
            const { files } = await unpackPackage(tgz);
            const platforms = (pkg.platforms ?? []).map((p) => (typeof p === "string" ? p : p.name));
            libs.push({ owner: pkg.owner.username, name: pkg.name, version: pkg.version.name, rank: pkg.popularity_rank ?? 0, platforms, examples: examplesOf(files) });
            console.log(`${libs.length}. ${pkg.owner.username}/${pkg.name}@${pkg.version.name} (rank ${pkg.popularity_rank}, ${platforms.join(",") || "*"}): ${libs.at(-1)!.examples.length} examples`);
        }
    }
    writeFileSync(join(REGISTRY_CORPUS, "list.json"), JSON.stringify(libs, null, 1));
}

if (import.meta.main) await main();
