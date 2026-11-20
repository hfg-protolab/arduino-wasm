#!/usr/bin/env node
// Run one wasm tool (cc1, cc1plus, as, ld) with literal arguments under Node, host file system
// mounted at the same paths (NODEFS). For checks outside compile.mjs' cc1plus → as → ld flow,
// e.g. a .c file through cc1, or `cc1plus -E -dM`.
//
//   node run-tool.mjs <tools dir> <tool> <cwd> <mount dir>... -- <args...>
// stdout/stderr of the tool are passed through; the exit code is the tool's.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const [tools, tool, cwd, ...mounts] = argv.slice(0, sep);
const args = argv.slice(sep + 1);

const path = join(tools, `${tool}.js`);
const module = { exports: {} };
new Function("module", "exports", "require", "__filename", "__dirname", readFileSync(path, "utf8"))(module, module.exports, require, path, dirname(path));
const wasm = await WebAssembly.compile(readFileSync(join(tools, `${tool}.wasm`)));
const m = await module.exports({
    noInitialRun: true,
    thisProgram: `/opt/${tool}`,
    print: (s) => process.stdout.write(s + "\n"),
    printErr: (s) => process.stderr.write(s + "\n"),
    quit: (status, toThrow) => { throw toThrow; },
    instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then((i) => done(i, wasm)); return {}; },
});
const NODEFS = m.NODEFS ?? m.FS.filesystems.NODEFS;
for (const d of [...new Set([cwd, ...mounts])].filter((d, _, a) => !a.some((x) => x !== d && d.startsWith(x + "/")))) {
    m.FS.mkdirTree(d);
    m.FS.mount(NODEFS, { root: d }, d);
}
m.FS.mkdirTree("/tmp");
m.FS.chdir(cwd);
let code = 0;
const t0 = performance.now();
try { code = m.callMain([...args]) ?? 0; } catch (e) { if (e && typeof e.status === "number") code = e.status; else throw e; }
process.stderr.write(`[${tool}: exit ${code}, ${(performance.now() - t0).toFixed(0)} ms]\n`);
process.exit(code);
