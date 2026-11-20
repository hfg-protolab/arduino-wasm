#!/usr/bin/env node
// Raw and Brotli (quality 11, lgwin 24) sizes of a toolchain dir, in MB (10^6 bytes), as in
// toolchains/README.md.   node sizes.mjs <dir>...
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants as Z } from "node:zlib";

const mb = (n) => (n / 1e6).toFixed(2);
for (const dir of process.argv.slice(2)) {
    let raw = 0, br = 0, js = [0, 0];
    const row = {};
    for (const f of readdirSync(dir).sort()) {
        const b = readFileSync(join(dir, f));
        const c = brotliCompressSync(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_LGWIN]: 24, [Z.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
        raw += b.length; br += c;
        if (f.endsWith(".js")) { js[0] += b.length; js[1] += c; } else row[f] = `${mb(b.length)} / ${mb(c)}`;
    }
    console.log(`${dir}\n  ${Object.entries(row).map(([k, v]) => `${k} ${v}`).join("\n  ")}\n  4 x .js ${mb(js[0])} / ${mb(js[1])}\n  total raw ${mb(raw)}  brotli ${mb(br)}`);
}
