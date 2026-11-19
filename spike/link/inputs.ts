/**
 * Node side of the resolver: reads the files a captured ld argv names and turns them into
 * ResolveInput[] (objects with their symbols, archives with their symbol index). In the pack
 * builder this produces the per-board symbol index; in the browser the index is downloaded.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { readArchive } from "./ar.ts";
import { createHash } from "node:crypto";
import { run, SCRATCH, toolBin } from "./common.ts";
import { elfSymbols, isLtoObject, nmSymbols, type ObjSymbol } from "./elf.ts";
import { parseLdArgs, scriptRoots, type LdPlan } from "./ldargs.ts";
import type { ArchiveIndex, ResolveInput } from "./resolve.ts";

const archiveCache = new Map<string, ArchiveIndex & { data: Array<Uint8Array> }>();

function objectSymbols(buf: Uint8Array, triple: string): ObjSymbol[] {
    if (!isLtoObject(buf)) return elfSymbols(buf);
    // GCC LTO slim object: symbols live in the IR, ask <triple>-gcc-nm (plugin).
    const d = mkdtempSync(join(tmpdir(), "lto-"));
    try {
        writeFileSync(join(d, "m.o"), buf);
        const r = run(join(toolBin(triple), `${triple}-gcc-nm`), ["-P", join(d, "m.o")]);
        if (r.code !== 0) throw new Error(r.stderr);
        return nmSymbols(r.stdout);
    } finally {
        rmSync(d, { recursive: true, force: true });
    }
}

/**
 * STRIP=…: use a copy of the archive without debug info (what the pack would ship: the ESP-IDF
 * archives are built with -ggdb). STRIP=strip → `objcopy --strip-debug` (renumbers symbols;
 * changes .eh_frame of discarded COMDAT copies on Xtensa), STRIP=rm → `objcopy -R .debug_*`
 * (drops only the .debug_* sections and their relocations, symbol table untouched).
 */
export function packArchivePath(abs: string, triple: string): string {
    if (!process.env.STRIP) return abs;
    const mode = process.env.STRIP === "rm" ? "rm" : "strip";
    const out = join(SCRATCH, `stripped-${mode}`, createHash("sha1").update(abs).digest("hex").slice(0, 12), abs.split("/").pop()!);
    if (!existsSync(out)) {
        mkdirSync(dirname(out), { recursive: true });
        const r = run(join(toolBin(triple), `${triple}-objcopy`), [...(mode === "rm" ? ["-R", ".debug_*"] : ["--strip-debug"]), abs, out]);
        if (r.code !== 0) throw new Error(`strip ${abs}: ${r.stderr}`);
    }
    return out;
}

export function loadArchive(abs: string, triple: string) {
    abs = packArchivePath(abs, triple);
    const key = `${abs}:${statSync(abs).mtimeMs}`;
    let a = archiveCache.get(key);
    if (!a) {
        const ar = readArchive(new Uint8Array(readFileSync(abs)));
        a = {
            members: ar.members.map((m) => ({ name: m.name, size: m.data.length, syms: objectSymbols(m.data, triple) })),
            armap: ar.armap.map((e) => [e.symbol, e.member] as [string, number]),
            data: ar.members.map((m) => m.data),
        };
        archiveCache.set(key, a);
    }
    return a;
}

export interface LinkInputs {
    plan: LdPlan;
    inputs: ResolveInput[];
    roots: string[];
    /** absolute path of every input file by the path ld sees */
    abs: Map<string, string>;
}

export function linkInputs(ldArgs: string[], cwd: string, triple: string): LinkInputs {
    const abs = new Map<string, string>();
    const resolveFile = (name: string, dirs: string[], isLib: boolean) => {
        const cands = isLib ? dirs.map((d) => `${d}/${name}`) : [name, ...dirs.map((d) => `${d}/${name}`)];
        for (const c of cands) {
            const a = isAbsolute(c) ? c : join(cwd, c);
            if (existsSync(a) && statSync(a).isFile()) { abs.set(c, a); return c; }
        }
        return null;
    };
    const plan = parseLdArgs(ldArgs, resolveFile);
    const inputs: ResolveInput[] = [];
    const roots = [...plan.undefined];
    let entry = plan.entry;
    for (const inp of plan.inputs) {
        if (inp.kind === "script") {
            const r = scriptRoots(readFileSync(abs.get(inp.path) ?? join(cwd, inp.path), "utf8"));
            if (r.includes.length || r.inputs.length) throw new Error(`INCLUDE/INPUT in ${inp.path} not handled`);
            roots.push(...r.externs);
            if (r.entry && !plan.entry) entry = r.entry;
        } else if (inp.kind === "object") {
            const p = abs.get(inp.path) ?? join(cwd, inp.path);
            inputs.push({ kind: "object", path: inp.path, syms: objectSymbols(new Uint8Array(readFileSync(p)), triple) });
        } else if (inp.kind === "archive") {
            inputs.push({ kind: "archive", path: inp.path, index: loadArchive(abs.get(inp.path)!, triple), whole: inp.whole });
        } else inputs.push(inp);
    }
    if (entry) roots.push(entry);
    return { plan, inputs, roots, abs };
}
