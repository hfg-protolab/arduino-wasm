/**
 * Step 1: from a native `pio run -v` log, take the firmware link command, re-run it through
 * the gcc driver with `-v -Wl,-Map` and record what the driver really hands to ld
 * (collect2 argv, environment for lto-wrapper) plus ld's own choice of archive members (Map file).
 * Then runs ld directly with that argv and checks the ELF equals pio's firmware.elf, so later
 * steps can drive ld without the gcc driver (decision 2 of the plan).
 *
 *   node capture.ts <sketch> <env>     → $SCRATCH/cap/<sketch>.<env>/link.json
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, SCRATCH, shellSplit, toolBin } from "./common.ts";

export interface LinkCapture {
    sketch: string;
    env: string;
    triple: string;
    cwd: string;
    /** gcc driver link command from the pio log. */
    gccLink: string[];
    /** argv of ld (collect2's argv without collect2-only flags), output = "@OUT@". */
    ldArgs: string[];
    ldPath: string;
    /** Environment collect2 had (lto-wrapper needs COLLECT_GCC / COLLECT_GCC_OPTIONS). */
    ldEnv: Record<string, string>;
    /** Archive members ld pulled, in load order: "archive(member)" as the Map prints them. */
    trace: string[];
    /** Post-link commands from the pio log (objcopy / esptool elf2image), relative to cwd. */
    post: string[];
    /** Every compile command (for the header closure). */
    compiles: string[];
}

export function capDir(sketch: string, env: string) {
    return join(SCRATCH, "cap", `${sketch}.${env}`);
}

/** Archive members ld pulled, from the Map ("Archive member included to satisfy reference"). */
export function parseMapMembers(map: string): string[] {
    const start = map.indexOf("Archive member included");
    const end = map.search(/\n(Allocating common symbols|Discarded input sections|Memory Configuration)/);
    const out: string[] = [];
    for (const line of map.slice(start, end).split("\n").slice(1)) {
        if (line && !/^\s/.test(line) && line.endsWith(")")) out.push(line);
    }
    return out;
}

export function capture(sketch: string, env: string): LinkCapture {
    const cwd = join(SCRATCH, "proj", sketch);
    const log = readFileSync(join(SCRATCH, "logs", `${sketch}.${env}.log`), "utf8").split("\n");
    const linkRe = new RegExp(`^(\\S+)-g\\+\\+ -o \\.pio/build/${env.replace(/[-.]/g, "\\$&")}/firmware\\.elf `);
    const linkLine = log.find((l) => linkRe.test(l));
    if (!linkLine) throw new Error(`no link line in log ${sketch}.${env}`);
    const triple = linkRe.exec(linkLine)![1];
    const bin = toolBin(triple);
    const gccLink = shellSplit(linkLine);
    const post = log.filter((l) => / elf2image | -O ihex /.test(l));
    const compiles = log.filter((l) => new RegExp(`^${triple}-g(cc|\\+\\+) -o \\.pio/build/${env}/.* -c `).test(l));

    const dir = capDir(sketch, env);
    mkdirSync(dir, { recursive: true });
    const args = gccLink.slice(1).filter((a) => !a.startsWith("-Wl,-Map="));
    args[args.indexOf("-o") + 1] = join(dir, "driver.elf");
    const PATH = `${bin}:${process.env.PATH}`;
    const r = run(join(bin, `${triple}-g++`), [...args, "-v", `-Wl,-Map=${join(dir, "driver.map")}`], { cwd, env: { ...process.env, PATH } });
    if (r.code !== 0) throw new Error(`driver link failed:\n${r.stderr.slice(-3000)}`);
    writeFileSync(join(dir, "driver.stderr.txt"), r.stderr);
    writeFileSync(join(dir, "driver.stdout.txt"), r.stdout);
    const lines = r.stderr.split("\n");
    const ci = lines.findIndex((l) => /\/collect2(\s|$)/.test(l.trim().split(" ")[0]));
    if (ci < 0) throw new Error("no collect2 line");
    const ldEnv: Record<string, string> = {};
    for (const l of lines.slice(0, ci)) {
        const m = /^(COLLECT_[A-Z_]+|LIBRARY_PATH|COMPILER_PATH)=(.*)$/.exec(l);
        if (m) ldEnv[m[1]] = m[2];
    }
    // gcc -v prints collect2's argv unquoted: re-join path pieces split at spaces
    // ("lib001/libAdafruit BusIO.a").
    const pieces = lines[ci].trim().split(/ +/).slice(1);
    const collect: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
        let a = pieces[i];
        if (a.includes("/") && !a.startsWith("-") && !existsSync(join(cwd, a))) {
            let j = i;
            while (j + 1 < pieces.length && !existsSync(join(cwd, a))) a += " " + pieces[++j];
            if (existsSync(join(cwd, a))) i = j;
            else a = pieces[i];
        }
        collect.push(a);
    }
    // collect2-only switches (ld rejects them); --trace and the Map we added ourselves.
    const ldArgs = collect.filter((a) => !/^-f(no-)?lto/.test(a) && a !== "--trace" && !a.startsWith("-Map="));
    ldArgs[ldArgs.indexOf("-o") + 1] = "@OUT@";
    const ldPath = run(join(bin, `${triple}-g++`), ["-print-prog-name=ld"], { env: { ...process.env, PATH } }).stdout.trim();
    const trace = parseMapMembers(readFileSync(join(dir, "driver.map"), "utf8"));

    const cap: LinkCapture = { sketch, env, triple, cwd, gccLink, ldArgs, ldPath, ldEnv, trace, post, compiles };
    writeFileSync(join(dir, "link.json"), JSON.stringify(cap, null, 1));

    // ld direct == pio's firmware.elf?
    const direct = join(dir, "direct.elf");
    const d = run(ldPath, ldArgs.map((a) => (a === "@OUT@" ? direct : a)), { cwd, env: { ...process.env, PATH, ...ldEnv } });
    if (d.code !== 0) throw new Error(`direct ld failed:\n${d.stderr.slice(-3000)}`);
    const pioElf = join(cwd, ".pio/build", env, "firmware.elf");
    copyFileSync(pioElf, join(dir, "pio.elf"));
    for (const f of ["firmware.bin", "firmware.hex", "bootloader.bin", "partitions.bin"]) {
        const p = join(cwd, ".pio/build", env, f);
        if (existsSync(p)) copyFileSync(p, join(dir, `pio.${f}`));
    }
    const same = Buffer.compare(readFileSync(direct), readFileSync(pioElf)) === 0;
    console.log(`${sketch}.${env}: ld args ${ldArgs.length}, trace ${trace.length} files, direct ld == pio elf: ${same}`);
    return cap;
}

if (import.meta.main) {
    const [sketch, env] = process.argv.slice(2);
    capture(sketch, env);
}
