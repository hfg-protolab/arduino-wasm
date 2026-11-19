/**
 * Step 0: native reference builds. From config.json: installs the libraries into
 * $SCRATCH/libs/<dir>, writes one PlatformIO project per sketch (one env per board, like a
 * hub would: platform + board pinned, framework arduino, lib_extra_dirs, LDF chain) and runs
 * `pio run -v` per env into $SCRATCH/logs/<sketch>.<board>.log (a clean build each time, so
 * the log holds every compile line). `noLto` sketches add build_unflags = -flto.
 *
 *   node projects.ts [<sketch> ...]
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardDef, CONFIG, PIO, run, SCRATCH } from "./common.ts";

const only = process.argv.slice(2);
const libRoot = join(SCRATCH, "libs");
for (const l of CONFIG.libraries) {
    mkdirSync(join(libRoot, l.dir), { recursive: true });
    const r = run(PIO, ["pkg", "install", "--global", "--storage-dir", join(libRoot, l.dir), "--library", l.spec]);
    if (r.code !== 0) throw new Error(`install ${l.spec}: ${r.stderr}`);
}
mkdirSync(join(SCRATCH, "logs"), { recursive: true });
for (const sk of CONFIG.sketches) {
    if (only.length && !only.includes(sk.name)) continue;
    const dir = join(SCRATCH, "proj", sk.name);
    mkdirSync(join(dir, "src"), { recursive: true });
    copyFileSync(new URL(`./sketches/${sk.source ?? sk.name}.ino`, import.meta.url), join(dir, "src/main.ino"));
    const ini = ["[platformio]", "src_dir = src", ""];
    for (const id of sk.boards) {
        const b = boardDef(id);
        ini.push(`[env:${id}]`, `platform = ${b.platform}`, `board = ${b.board}`, "framework = arduino",
            `lib_extra_dirs = ${join(libRoot, "all")}, ${join(libRoot, b.arch)}`, "lib_ldf_mode = chain",
            ...(sk.noLto ? ["build_unflags = -flto -fuse-linker-plugin"] : []), "");
    }
    writeFileSync(join(dir, "platformio.ini"), ini.join("\n"));
    for (const id of sk.boards) {
        rmSync(join(dir, ".pio/build", id), { recursive: true, force: true });
        const r = run(PIO, ["run", "-v", "-e", id], { cwd: dir });
        writeFileSync(join(SCRATCH, "logs", `${sk.name}.${id}.log`), r.stdout + r.stderr);
        console.log(`${sk.name}.${id}: ${r.code === 0 ? "ok" : "FAILED"}`);
    }
}
