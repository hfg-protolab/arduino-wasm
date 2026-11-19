/**
 * Precompress a pack for static hosting: writes `<file>.br` (Brotli q11, the size the pack
 * builder reports) next to every file under `files/` where that is smaller. The runtime fetches
 * the plain names; a host that serves `<file>.br` with `Content-Encoding: br` to browsers that
 * accept it (nginx `brotli_static`, the AI Hub's `/firmware-toolchain/` route) then ships the
 * sizes the builder printed instead of the raw ones.
 *
 *   bun pack/compress.ts <packDir>            add .br files, keep the raw ones
 *   bun pack/compress.ts <packDir> --br-only  then delete each raw file that got a .br
 *                                             (smaller image; every Chromium sends br)
 *
 * Idempotent: an existing `.br` that is newer than its file is kept.
 */
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotli, readBytes } from "./common.ts";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const brOnly = args.includes("--br-only");
if (!dir || !existsSync(join(dir, "index.json"))) {
    console.error("usage: bun pack/compress.ts <packDir> [--br-only]   (a directory with index.json)");
    process.exit(2);
}

const filesDir = join(dir, "files");
let raw = 0;
let shipped = 0;
let written = 0;
for (const name of readdirSync(filesDir)) {
    if (name.endsWith(".br")) continue;
    const path = join(filesDir, name);
    const br = `${path}.br`;
    const size = statSync(path).size;
    raw += size;
    if (existsSync(br) && statSync(br).mtimeMs >= statSync(path).mtimeMs) {
        const brSize = statSync(br).size;
        shipped += brSize;
        if (brOnly) unlinkSync(path);
        continue;
    }
    const out = brotli(readBytes(path));
    if (out.length >= size) {
        shipped += size;
        continue;
    }
    writeFileSync(br, out);
    written++;
    shipped += out.length;
    if (brOnly) unlinkSync(path);
}
const MB = (n: number) => (n / 1e6).toFixed(1);
console.log(`${filesDir}: ${MB(raw)} MB raw → ${MB(shipped)} MB served (${written} .br written${brOnly ? ", raw files removed" : ""})`);
