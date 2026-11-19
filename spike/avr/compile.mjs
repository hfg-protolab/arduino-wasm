// Phase-0 spike: run the AVR toolchain (cc1/cc1plus, as, ld as WebAssembly) under Node and
// reproduce a native `pio run -v` build byte for byte.
//
//   node compile.mjs --project <pio project> --log <pio run -v log> --tools <dir with *.js/*.wasm>
//                    --out <dir> [--all] [--repeat N]
//
// The command lines are not hand-written: for every compile in the log the *native* driver is
// asked with `-###` which cc1plus/cc1/as/collect2 calls it would make (that is the information
// Phase 1 stores in the manifest). collect2 becomes a direct ld call without the LTO plugin.
// Without --all only the sketch (src/…) is compiled in wasm; the core/library archives come
// from the native no-LTO build in the project. With --all every TU is compiled in wasm and each
// .o is compared against the native one. Files come in via NODEFS; the MEMFS/browser path is
// browser/ (same plan.json, headless Chrome).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => {
        if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
        return acc;
    }, []),
);
const project = resolve(args.project);
const log = readFileSync(resolve(args.log), "utf8");
const toolsDir = resolve(args.tools);
const out = resolve(args.out);
const repeat = Number(args.repeat ?? 1);
const TC = join(process.env.HOME, ".platformio/packages/toolchain-atmelavr");
mkdirSync(join(out, "tmp"), { recursive: true });

// ---------------------------------------------------------------- shell words (gcc -### output)
function words(line) {
    const r = [];
    let cur = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            cur ??= "";
            for (i++; i < line.length && line[i] !== '"'; i++) cur += line[i] === "\\" ? line[++i] : line[i];
        } else if (c === " ") {
            if (cur !== null) r.push(cur), (cur = null);
        } else cur = (cur ?? "") + (c === "\\" ? line[++i] : c);
    }
    if (cur !== null) r.push(cur);
    return r;
}

// ---------------------------------------------------------------- plan (native driver -###)
const ino = join(project, "src/main.ino.cpp");
const keep = join(project, "main.ino.cpp.keep");
if (existsSync(keep)) copyFileSync(keep, ino);
let tmpN = 0;
function plan(cmdLine, outObj) {
    const w = words(cmdLine);
    const i = w.indexOf("-o");
    if (outObj) w[i + 1] = outObj;
    const r = spawnSync(join(TC, "bin", w[0]), ["-###", ...w.slice(1)], { cwd: project, encoding: "utf8" });
    const steps = [];
    const temps = new Map();
    for (const l of r.stderr.split("\n")) {
        if (!l.startsWith(" ")) continue;
        let [tool, ...a] = words(l.trim());
        tool = basename(tool);
        a = a.map((x) => {
            const m = x.match(/^(.*?)(\/var\/folders\/\S+?\/cc\w+\.(\w+))$/);
            if (!m) return x;
            if (!temps.has(m[2])) temps.set(m[2], join(out, "tmp", `t${tmpN++}.${m[3]}`));
            return m[1] + temps.get(m[2]);
        });
        if (tool === "collect2") {
            tool = "ld";
            a = a.filter((x, j) => !(x === "-plugin" || a[j - 1] === "-plugin" || x.startsWith("-plugin-opt=")));
        }
        steps.push({ tool, args: a });
    }
    if (!steps.length) throw new Error(`no steps for: ${cmdLine}\n${r.stderr}`);
    return steps;
}

const lines = log.split("\n");
const compileLines = lines.filter((l) => /^avr-g(cc|\+\+) .* -c /.test(l));
const linkLine = lines.find((l) => /^avr-g\+\+ -o \.pio\/build\/\w+\/firmware\.elf /.test(l));
const ENV = linkLine.match(/\.pio\/build\/(\w+)\//)[1];
const jobs = compileLines
    .filter((l) => args.all || / src\//.test(l))
    .map((l) => {
        const nativeObj = words(l)[words(l).indexOf("-o") + 1];
        const wasmObj = join(out, "obj", nativeObj.replace(/^\.pio\/build\/\w+\//, ""));
        mkdirSync(dirname(wasmObj), { recursive: true });
        return { nativeObj: join(project, nativeObj), wasmObj, steps: plan(l, wasmObj) };
    });
// Link: the sketch object from wasm, archives from the native build dir.
const sketchJob = jobs.find((j) => j.nativeObj.endsWith("src/main.ino.cpp.o"));
const elf = join(out, "firmware.elf");
const linkSteps = plan(linkLine, elf).map((s) => ({
    ...s,
    args: s.args.map((a) => (a === `.pio/build/${ENV}/src/main.ino.cpp.o` ? sketchJob.wasmObj : a)),
}));
writeFileSync(join(out, "plan.json"), JSON.stringify({ jobs, linkSteps }, null, 2));

// ---------------------------------------------------------------- wasm runner
const modules = {};
const timings = [];
let peakHeap = 0;
async function loadTool(name) {
    if (modules[name]) return modules[name];
    const t0 = performance.now();
    const bytes = readFileSync(join(toolsDir, `${name}.wasm`));
    const mod = await WebAssembly.compile(bytes);
    const factory = require(join(toolsDir, `${name}.js`));
    const ms = performance.now() - t0;
    timings.push({ step: `compile-module ${name}`, ms });
    return (modules[name] = { mod, factory });
}

async function run(name, argv, label) {
    const { mod, factory } = await loadTool(name);
    const stderr = [];
    const t0 = performance.now();
    const M = await factory({
        instantiateWasm(imports, done) {
            WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod));
            return {};
        },
        print: (s) => stderr.push(s),
        printErr: (s) => stderr.push(s),
        // ld finds its default linker script relative to argv[0] (find_scripts_dir: <dir of
        // program>/ldscripts). The scripts are the native toolchain's (Atmel-patched) ones.
        thisProgram: `/${name}/${name}`,
        quit: (status, e) => {
            throw e;
        },
    });
    const tInst = performance.now();
    const FS = M.FS;
    for (const root of ["/Users", "/private"]) {
        FS.mkdirTree(root);
        FS.mount(FS.filesystems.NODEFS, { root }, root);
    }
    if (name === "ld") {
        FS.mkdirTree("/ld/ldscripts");
        FS.mount(FS.filesystems.NODEFS, { root: join(TC, "avr/lib/ldscripts") }, "/ld/ldscripts");
    }
    FS.chdir(project);
    const tFs = performance.now();
    let code;
    try {
        code = M.callMain([...argv]); // callMain unshifts argv[0] into the array it gets
    } catch (e) {
        code = e?.status ?? -1;
        if (code === -1) stderr.push(String(e?.stack ?? e));
    }
    const tEnd = performance.now();
    const heap = M.HEAPU8?.length ?? 0;
    peakHeap = Math.max(peakHeap, heap || 0);
    timings.push({ step: `${name} ${label}`, instMs: tInst - t0, fsMs: tFs - tInst, runMs: tEnd - tFs, heapMB: (heap || 0) / 2 ** 20 });
    if (code !== 0) {
        console.error(`${name} ${label} exited ${code}\n${stderr.join("\n")}`);
        process.exit(1);
    }
    if (stderr.length) console.error(stderr.join("\n"));
}

for (let r = 0; r < repeat; r++) {
    const tAll = performance.now();
    for (const j of jobs) for (const s of j.steps) await run(s.tool, s.args, basename(j.nativeObj));
    for (const s of linkSteps) await run(s.tool, s.args, "firmware.elf");
    const total = performance.now() - tAll;
    timings.push({ step: `TOTAL round ${r}`, ms: total });
}
if (existsSync(keep)) rmSync(ino, { force: true });

// ---------------------------------------------------------------- compare
const OBJCOPY = join(TC, "bin/avr-objcopy");
spawnSync(OBJCOPY, ["-O", "ihex", "-R", ".eeprom", elf, join(out, "firmware.hex")]);
const nativeHex = readFileSync(join(project, `.pio/build/${ENV}/firmware.hex`));
const wasmHex = readFileSync(join(out, "firmware.hex"));
const objDiffs = jobs.filter((j) => !readFileSync(j.nativeObj).equals(readFileSync(j.wasmObj))).map((j) => j.nativeObj);
const summary = {
    project: basename(project),
    tus: jobs.length,
    objIdentical: `${jobs.length - objDiffs.length}/${jobs.length}`,
    objDiffs,
    hexIdentical: nativeHex.equals(wasmHex),
    hexBytes: wasmHex.length,
    peakHeapMB: peakHeap / 2 ** 20,
    rssMB: process.memoryUsage().rss / 2 ** 20,
};
console.table(timings.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 10) / 10 : v]))));
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(out, "summary.json"), JSON.stringify({ summary, timings }, null, 2));
