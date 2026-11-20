#!/usr/bin/env node
// Phase-0 spike (ESP32 / esp32dev): compile and link an Arduino sketch with the wasm builds of
// cc1plus, as and ld under Node — no gcc driver, no collect2. The command lines come from
// manifest.esp32dev.json (extract-manifest.mjs, from the native driver's `-###`).
//
// The spike mounts the host file system (NODEFS) at the same paths, so the manifest's absolute
// paths resolve unchanged: PlatformIO's packages (headers, framework .a, linker scripts, libgcc,
// newlib) and the native pio project (its prebuilt libFrameworkArduino.a). In the browser this
// becomes MEMFS filled from the pack.
//
//   node compile.mjs --tools <dir> --project <pio project> --src <file> [--obj <file>]
//                    [--pch <file.gch>] [--gen-pch <header> <out.gch>] [--runs N] [--no-link]
//
// Prints per-step wall times (cold = WebAssembly.compile + instantiate + run; warm = compiled
// module reused, fresh instance, as a worker pool or Chrome's code cache would), peak wasm
// memory per tool, and writes <out>/firmware.elf.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const o = { runs: 1, link: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--tools") o.tools = resolve(argv[++i]);
        else if (a === "--project") o.project = resolve(argv[++i]);
        else if (a === "--src") o.src = argv[++i];
        else if (a === "--obj") o.obj = argv[++i];
        else if (a === "--out") o.out = resolve(argv[++i]);
        else if (a === "--pch") o.pch = argv[++i];
        else if (a === "--gen-pch") { o.genPch = [argv[++i], argv[++i]]; }
        else if (a === "--runs") o.runs = Number(argv[++i]);
        else if (a === "--no-link") o.link = false;
        else if (a === "--memfs") o.memfs = true;   // runs after the first: inputs preloaded into MEMFS
        else if (a === "--from-asm") o.fromAsm = resolve(argv[++i]);   // skip cc1plus (test as/ld alone)
        else if (a === "--manifest") o.manifest = resolve(argv[++i]);
        else throw new Error(`unknown arg ${a}`);
    }
    return o;
}

const opts = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(opts.manifest ?? join(here, "manifest.esp32dev.json"), "utf8"));
const PKG = process.env.PIO_PACKAGES ?? join(homedir(), ".platformio/packages");
const out = opts.out ?? join(opts.project, ".wasm");
mkdirSync(out, { recursive: true });

// ---- tool runner -------------------------------------------------------------------------
const compiled = new Map();   // tool → WebAssembly.Module (warm runs reuse it)
// --memfs: the first (NODEFS) run of each tool records which host files it reads; later runs get
// exactly those files in MEMFS (as the browser will) and outputs are copied back to the host.
const inputs = new Map();     // tool → Map(path → Buffer)

// The Emscripten loaders are CommonJS-style scripts; a parent package.json with "type": "module"
// (this repo) would make require() load them as ESM, where they export nothing. Evaluate them as
// CommonJS explicitly instead.
const factories = new Map();
function loadFactory(path) {
    if (!factories.has(path)) {
        const module = { exports: {} };
        new Function("module", "exports", "require", "__filename", "__dirname", readFileSync(path, "utf8"))(module, module.exports, require, path, dirname(path));
        factories.set(path, module.exports);
    }
    return factories.get(path);
}

async function runTool(tool, args, { cwd, mounts }) {
    const t0 = performance.now();
    let module = compiled.get(tool);
    const cold = !module;
    if (!module) {
        module = await WebAssembly.compile(readFileSync(join(opts.tools, `${tool}.wasm`)));
        compiled.set(tool, module);
    }
    const tCompiled = performance.now();
    const factory = loadFactory(join(opts.tools, `${tool}.js`));
    let memory;
    const stderr = [], stdout = [];
    const m = await factory({
        noInitialRun: true,
        print: (s) => stdout.push(s),
        printErr: (s) => stderr.push(s),
        quit: (status, toThrow) => { throw toThrow; },
        instantiateWasm(imports, done) {
            WebAssembly.instantiate(module, imports).then((inst) => {
                memory = inst.exports.memory ?? Object.values(inst.exports).find((e) => e instanceof WebAssembly.Memory);
                done(inst, module);
            });
            return {};
        },
    });
    const { FS } = m;
    const NODEFS = m.NODEFS ?? FS.filesystems.NODEFS;
    const preload = opts.memfs ? inputs.get(tool) : undefined;
    const written = new Set();
    let tFs = performance.now();
    if (preload) {
        for (const [p, data] of preload) { FS.mkdirTree(dirname(p)); FS.writeFile(p, data); }
        FS.mkdirTree(cwd);
        for (const d of mounts) FS.mkdirTree(d);
    } else {
        for (const dir of mounts) {
            FS.mkdirTree(dir);
            FS.mount(NODEFS, { root: dir }, dir);
        }
    }
    const seen = new Set();
    const open = FS.open;
    FS.open = function (path, flags, mode) {
        const st = open.call(this, path, flags, mode);
        const f = typeof flags === "string" ? flags : flags & 3;
        if (f === "r" || f === 0) seen.add(st.path); else written.add(st.path);
        return st;
    };
    FS.mkdirTree("/tmp");
    FS.chdir(cwd);
    tFs = performance.now() - tFs;
    const tReady = performance.now();
    let code = 0;
    try {
        code = m.callMain(args) ?? 0;
    } catch (e) {
        if (e && typeof e.status === "number") code = e.status;
        else throw e;
    }
    process.exitCode = 0;
    const tDone = performance.now();
    if (opts.memfs && !preload) {
        const map = new Map();
        for (const p of seen) {
            if (written.has(p) || p.startsWith("/tmp/") || p.startsWith("/dev/")) continue;
            try { map.set(p, readFileSync(p)); } catch {}
        }
        inputs.set(tool, map);
    }
    if (preload) for (const p of written) {
        if (p.startsWith("/tmp/") || p.startsWith("/dev/")) continue;
        try { writeFileSync(p, FS.readFile(p)); } catch {}
    }
    return {
        tool, code, cold, stderr: stderr.join("\n"), stdout: stdout.join("\n"),
        ms: { compile: tCompiled - t0, instantiate: tReady - tCompiled - tFs, fs: tFs, run: tDone - tReady, total: tDone - t0 },
        fs: preload ? "memfs" : "nodefs", inputMB: preload ? [...preload.values()].reduce((a, b) => a + b.length, 0) / 2 ** 20 : undefined,
        memMB: memory ? memory.buffer.byteLength / 2 ** 20 : NaN,
        FS,
    };
}

// ---- command lines -----------------------------------------------------------------------
const sub = (args, vars) => args.map((a) => a.replace(/\$\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`no value for \${${k}}`);
    return vars[k];
}));

const asmPath = opts.fromAsm ?? join(out, "sketch.s");
const objPath = opts.obj ? resolve(opts.project, opts.obj) : join(out, `${basename(opts.src)}.o`);
const elfPath = join(out, "firmware.elf");
const vars = {
    PKG, BUILD: `.pio/build/${manifest.board}`, SRC: opts.src, SRC_BASE: basename(opts.src),
    ASM: asmPath, OBJ: objPath, ELF: elfPath,
};
// Nested dirs ride on their parent's mount.
const mounts = [...new Set([PKG, opts.project, out, ...(opts.fromAsm ? [dirname(opts.fromAsm)] : [])])].filter((d, _, a) => !a.some((x) => x !== d && d.startsWith(x + "/")));

function check(r) {
    const line = `${r.tool.padEnd(8)} ${r.cold ? "cold" : "warm"} ${r.fs}${r.inputMB ? ` (${r.inputMB.toFixed(1)} MiB in)` : ""}  wasm-compile ${r.ms.compile.toFixed(0).padStart(5)} ms  instantiate ${r.ms.instantiate.toFixed(0).padStart(4)} ms  run ${r.ms.run.toFixed(0).padStart(6)} ms  peak ${r.memMB.toFixed(0)} MiB`;
    console.log(line);
    if (r.code !== 0) {
        console.error(r.stderr);
        throw new Error(`${r.tool} exited ${r.code}`);
    }
    if (r.stderr.trim()) console.log(r.stderr.split("\n").slice(0, 20).map((l) => "  | " + l).join("\n"));
}

// cc1plus args: optionally drop the source and compile a header to a PCH instead, or prepend
// -include for a PCH (GCC looks for <header>.gch next to the named header).
function ccArgs() {
    let a = sub(manifest.cc1plus, vars);
    if (opts.pch) a = ["-include", opts.pch.replace(/\.gch$/, ""), "-Winvalid-pch", ...a];
    return a;
}

const results = [];
for (let run = 0; run < opts.runs; run++) {
    const t0 = performance.now();
    if (opts.genPch) {
        const [header, gch] = opts.genPch;
        let a = sub(manifest.cc1plus, { ...vars, SRC: header, SRC_BASE: basename(header), OBJ: gch });
        // header mode: cc1plus writes the PCH to the -o file given via --output-pch=
        const i = a.indexOf("-o");
        // (GCC ≥ 11 takes the file as a separate argument: `--output-pch <file>`)
        const pchOut = resolve(opts.project, gch);
        a.splice(i, 2, "-o", "/tmp/pch.s",
            ...(Number(manifest.gccVersion?.split(".")[0]) >= 11 ? ["--output-pch", pchOut] : [`--output-pch=${pchOut}`]));
        const r = await runTool("cc1plus", a, { cwd: opts.project, mounts });
        check(r);
        continue;
    }
    const cc = opts.fromAsm ? { ms: {}, memMB: NaN } : await runTool("cc1plus", ccArgs(), { cwd: opts.project, mounts });
    if (!opts.fromAsm) check(cc);
    const as = await runTool("as", sub(manifest.as, vars), { cwd: opts.project, mounts }); check(as);
    let ld;
    if (opts.link) { ld = await runTool("ld", sub(manifest.ld, vars), { cwd: opts.project, mounts }); check(ld); }
    const total = performance.now() - t0;
    console.log(`run ${run + 1}: total ${total.toFixed(0)} ms`);
    results.push({ cc: cc.ms, as: as.ms, ld: ld?.ms, total, mem: { cc1plus: cc.memMB, as: as.memMB, ld: ld?.memMB } });
}
if (results.length) console.log(JSON.stringify({ obj: objPath, elf: opts.link ? elfPath : null, results }));
