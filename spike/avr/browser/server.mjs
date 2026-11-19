// Phase-0 spike: run the same plan as compile.mjs in headless Chrome (MEMFS, no NODEFS).
//
//   node browser/server.mjs --plan <out dir of a compile.mjs run> --project <pio project>
//                           --tools <dir> [--port 8765] [--chrome <path>] [--rounds 3]
//
// Serves index.html, the tools (.js/.wasm) and a bundle of exactly the files the plan reads:
// the sketch's header closure (native `-M`), sources, and the link inputs. Starts headless
// Chrome, waits for the page to POST its result, prints it and compares the hex.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => {
        if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
        return acc;
    }, []),
);
const planDir = resolve(args.plan);
const project = resolve(args.project);
const toolsDir = resolve(args.tools);
const port = Number(args.port ?? 8765);
const rounds = Number(args.rounds ?? 3);
const chrome = args.chrome ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TC = join(process.env.HOME, ".platformio/packages/toolchain-atmelavr");
const plan = JSON.parse(readFileSync(join(planDir, "plan.json"), "utf8"));

// ---- files the plan reads
const files = new Set();
const ino = join(project, "src/main.ino.cpp");
const keep = join(project, "main.ino.cpp.keep");
const log = readFileSync(join(project, "..", `${basename(project)}.log`), "utf8");
for (const l of log.split("\n").filter((l) => /^avr-g\+\+ .* -c .* src\//.test(l))) {
    // header closure of the sketch TU via the native driver (-M into a separate file, -o untouched)
    const w = l.match(/(?:[^\s"]+|"[^"]*")+/g).map((x) => x.replace(/^"|"$/g, ""));
    const i = w.indexOf("-o");
    w.splice(i, 2);
    const dep = join(planDir, "sketch.d");
    if (existsSync(keep)) writeFileSync(ino, readFileSync(keep));
    spawnSync(join(TC, "bin", w[0]), [...w.slice(1), "-M", "-MF", dep], { cwd: project });
    const d = readFileSync(dep, "utf8").replace(/\\\n/g, " ").replace(/^[^:]+:/, "");
    for (const m of d.matchAll(/((?:\\ |[^\s])+)/g)) files.add(resolve(project, m[1].replace(/\\ /g, " ")));
}
for (const j of plan.jobs) for (const s of j.steps) for (const a of s.args) if (/\.(c|cpp|S|ino\.cpp)$/.test(a)) files.add(resolve(project, a));
const link = plan.linkSteps[0].args;
const libDirs = [];
for (let i = 0; i < link.length; i++) {
    const a = link[i];
    if (a.startsWith("-L")) libDirs.push(resolve(project, a.slice(2)));
    else if (/\.(a|o)$/.test(a) && !a.startsWith(planDir)) files.add(resolve(project, a));
    else if (a.startsWith("-l")) {
        const d = libDirs.find((d) => existsSync(join(d, `lib${a.slice(2)}.a`)));
        if (d) files.add(join(d, `lib${a.slice(2)}.a`));
    }
}
const bundle = [...files].filter((f) => existsSync(f));
bundle.push(join(TC, "avr/lib/ldscripts/avr5.xn"));
let bytes = 0;
for (const f of bundle) bytes += readFileSync(f).length;
console.log(`bundle: ${bundle.length} files, ${(bytes / 2 ** 20).toFixed(2)} MB raw`);

const nativeHex = readFileSync(join(project, `.pio/build/${log.match(/\.pio\/build\/(\w+)\/firmware\.elf/)[1]}/firmware.hex`), "utf8");
let chromeProc;
const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") return res.end(readFileSync(join(import.meta.dirname, "index.html")));
    if (url.pathname === "/job.json")
        return res.end(JSON.stringify({ plan, project, out: planDir, bundle, rounds, ldscript: join(TC, "avr/lib/ldscripts/avr5.xn") }));
    if (url.pathname.startsWith("/tools/")) {
        const f = join(toolsDir, basename(url.pathname));
        res.setHeader("content-type", f.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        return res.end(readFileSync(f));
    }
    if (url.pathname === "/fs") {
        const p = url.searchParams.get("p");
        if (!bundle.includes(p)) return res.writeHead(404).end();
        return res.end(readFileSync(p));
    }
    if (url.pathname === "/result" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const r = JSON.parse(body);
            res.end("ok");
            writeFileSync(join(planDir, "browser-result.json"), JSON.stringify(r, null, 2));
            const { elfB64, ...rest } = r;
            console.log(JSON.stringify(rest, null, 2));
            if (elfB64) {
                const elf = join(planDir, "browser-firmware.elf");
                writeFileSync(elf, Buffer.from(elfB64, "base64"));
                const hex = join(planDir, "browser-firmware.hex");
                spawnSync(join(TC, "bin/avr-objcopy"), ["-O", "ihex", "-R", ".eeprom", elf, hex]);
                console.log("hexIdentical (browser vs native):", readFileSync(hex, "utf8") === nativeHex);
            }
            chromeProc?.kill();
            if (existsSync(keep)) rmSync(ino, { force: true });
            server.close();
            process.exit(0);
        });
        return;
    }
    res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => {
    chromeProc = spawn(chrome, [
        "--headless=new",
        "--no-first-run",
        "--disable-gpu",
        `--user-data-dir=${join(planDir, "chrome-profile")}`,
        "--remote-debugging-port=0",
        `http://127.0.0.1:${port}/`,
    ], { stdio: "ignore" });
    setTimeout(() => {
        console.error("timeout");
        chromeProc.kill();
        process.exit(1);
    }, 180000);
});
