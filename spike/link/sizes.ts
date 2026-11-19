/**
 * Step 3: download size with lazy linking, per sketch and board.
 *  - resolved members only (as separate files: Σ brotli per file; and as one concatenated
 *    blob, the lower bound for a bundled fetch), plus loose objects (crt*.o) and -T scripts;
 *  - union over all sketches of a board, dedupe by content across boards;
 *  - the alternative "fetch every archive of the link";
 *  - the symbol index itself (JSON, brotli).
 * Uses the archives as the pack would ship them: STRIP=strip (default here) or STRIP=rm or
 * STRIP=none.
 *
 *   node sizes.ts → stdout + $SCRATCH/sizes.json
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkCapture } from "./capture.ts";
import { boardDef, brotli, CONFIG, MB, SCRATCH } from "./common.ts";
import { linkInputs, loadArchive, packArchivePath } from "./inputs.ts";
import { resolve, type ArchiveIndex } from "./resolve.ts";

if (process.env.STRIP === undefined) process.env.STRIP = "strip";
if (process.env.STRIP === "none") delete process.env.STRIP;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cat = (bs: Uint8Array[]) => Buffer.concat(bs.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)));

/** Compact symbol index: per archive the member table and per member its symbols by kind. */
function symbolIndex(archives: Array<{ name: string; idx: ArchiveIndex; data: Uint8Array[] }>) {
    return {
        archives: archives.map(({ name, idx, data }) => ({
            name,
            members: idx.members.map((m, i) => {
                const by = (k: string) => m.syms.filter((s) => s.kind === k).map((s) => s.name);
                return { n: m.name, s: m.size, h: sha(data[i]).slice(0, 16), d: by("def"), w: by("weakdef"), c: by("common"), u: by("undef"), uw: by("weakundef") };
            }),
            // armap as member index per entry; the symbol names are those of the member's defs in order
            armap: idx.armap.map(([s, m]) => [m, s]),
        })),
    };
}

const BOARD_OF = (id: string) => id.slice(id.indexOf(".") + 1);
// LTO links are skipped for arches where a no-LTO variant exists (the plan links AVR without LTO).
const ltoArches = new Set(CONFIG.sketches.filter((s) => s.noLto).flatMap((s) => s.boards.map((b) => boardDef(b).arch)));
const caps = readdirSync(join(SCRATCH, "cap")).filter((id) => {
    const [sk] = id.split(".");
    const def = CONFIG.sketches.find((s) => s.name === sk);
    return def && (def.noLto || !ltoArches.has(boardDef(id.slice(sk.length + 1)).arch));
}).sort();
const boards = [...new Set(caps.map(BOARD_OF))];

const out: any = { strip: process.env.STRIP ?? "none", boards: {} };
const memberShaByBoard = new Map<string, Map<string, number>>();
for (const board of boards) {
    const ids = caps.filter((id) => BOARD_OF(id) === board);
    const union = new Map<string, Uint8Array>(); // sha → data
    const rows: any[] = [];
    let fullRaw = 0, fullBr = 0, indexRaw = 0, indexBr = 0, scriptsRaw = 0, scriptsBr = 0;
    for (const id of ids) {
        const cap: LinkCapture = JSON.parse(readFileSync(join(SCRATCH, "cap", id, "link.json"), "utf8"));
        const li = linkInputs(cap.ldArgs, cap.cwd, cap.triple);
        const res = resolve(li.inputs, li.roots, li.plan.wraps);
        const files: Uint8Array[] = [];
        for (const [path, ms] of res.members) {
            const a = loadArchive(li.abs.get(path)!, cap.triple);
            for (const m of ms) files.push(a.data[m]);
        }
        // loose objects except the sketch's own (compiled in the browser)
        for (const inp of li.inputs) if (inp.kind === "object" && !inp.path.includes("/src/")) files.push(new Uint8Array(readFileSync(li.abs.get(inp.path)!)));
        const scripts = li.plan.inputs.filter((i) => i.kind === "script").map((i) => new Uint8Array(readFileSync(li.abs.get(i.path)!)));
        const raw = files.reduce((n, f) => n + f.length, 0);
        const brEach = files.reduce((n, f) => n + brotli(f), 0);
        const brCat = brotli(cat(files));
        files.forEach((f) => union.set(sha(f), f));
        rows.push({ id, members: files.length, raw, brEach, brCat });
        console.log(`${id}: ${files.length} files, ${MB(raw)} MB raw, brotli ${MB(brEach)} MB per file / ${MB(brCat)} MB as one blob`);
        if (id === ids[ids.length - 1]) {
            // Board-level numbers from the last capture (all sketches share the IDF archives).
            const seen = new Set<string>();
            const archives: Array<{ name: string; idx: ArchiveIndex; data: Uint8Array[] }> = [];
            for (const inp of li.inputs) {
                if (inp.kind !== "archive" || seen.has(inp.path)) continue;
                seen.add(inp.path);
                const abs = packArchivePath(li.abs.get(inp.path)!, cap.triple);
                const b = new Uint8Array(readFileSync(abs));
                fullRaw += b.length;
                fullBr += brotli(b);
                const a = loadArchive(li.abs.get(inp.path)!, cap.triple);
                archives.push({ name: inp.path.split("/").pop()!, idx: a, data: a.data });
            }
            const idxJson = Buffer.from(JSON.stringify(symbolIndex(archives)));
            indexRaw = idxJson.length;
            indexBr = brotli(idxJson);
            writeFileSync(join(SCRATCH, `symindex.${board}.json`), idxJson);
            scriptsRaw = scripts.reduce((n, f) => n + f.length, 0);
            scriptsBr = brotli(cat(scripts));
        }
    }
    const u = [...union.values()];
    const unionRaw = u.reduce((n, f) => n + f.length, 0);
    const unionBr = u.reduce((n, f) => n + brotli(f), 0);
    memberShaByBoard.set(board, new Map([...union].map(([k, v]) => [k, v.length])));
    out.boards[board] = { rows, unionFiles: u.length, unionRaw, unionBr, fullRaw, fullBr, indexRaw, indexBr, scriptsRaw, scriptsBr };
    console.log(`${board}: union of ${ids.length} sketches ${u.length} files ${MB(unionRaw)} MB raw / ${MB(unionBr)} MB brotli; all archives of the link ${MB(fullRaw)} MB raw / ${MB(fullBr)} MB brotli; symbol index ${MB(indexRaw)} MB raw / ${MB(indexBr)} MB brotli; linker scripts ${MB(scriptsRaw)} MB raw / ${MB(scriptsBr)} MB brotli`);
}
// Cross-board content dedupe (ESP family).
const esp = [...memberShaByBoard].filter(([b]) => boardDef(b).arch === "esp32");
const all = new Map<string, number>();
esp.forEach(([, m]) => m.forEach((s, k) => all.set(k, s)));
const sumSep = esp.reduce((n, [, m]) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);
const dedup = [...all.values()].reduce((a, b) => a + b, 0);
out.espDedupe = { sumSeparate: sumSep, dedupedUnion: dedup };
console.log(`ESP family resolved-member unions: ${MB(sumSep)} MB raw separately, ${MB(dedup)} MB after content dedupe across esp32/s3/c3`);
writeFileSync(join(SCRATCH, `sizes.${out.strip}.json`), JSON.stringify(out, null, 1));
