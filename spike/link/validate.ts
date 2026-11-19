/**
 * Step 2: resolver vs ld, and the byte-identity check.
 *  1. resolve() on the captured argv → set + order of archive members.
 *  2. Compare with ld's choice (Map file of the native link).
 *  3. Repack only the resolved members into small archives (writeArchive, original member and
 *     armap order, same basename — the ESP-IDF sections.ld places code by "*libfoo.a:"),
 *     re-link with ld directly, compare ELF and flash image with pio's.
 *
 *   node validate.ts [<sketch>.<env> ...]   (default: every capture)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeArchive } from "./ar.ts";
import { parseMapMembers, type LinkCapture } from "./capture.ts";
import { run, SCRATCH, shellSplit, toolBin } from "./common.ts";
import { linkInputs, loadArchive, packArchivePath } from "./inputs.ts";
import { resolve } from "./resolve.ts";

export interface ValidateResult {
    id: string;
    ldMembers: number;
    resolved: number;
    missing: string[];
    extra: string[];
    orderEqual: boolean;
    elfIdentical: boolean;
    imageIdentical: boolean;
    miniBytes: number;
    fullArchiveBytes: number;
    resolveMs: number;
}

export function validate(id: string): ValidateResult {
    const dir = join(SCRATCH, "cap", id);
    const tag = process.env.STRIP ? `strip-${process.env.STRIP}.` : "";
    const cap: LinkCapture = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
    const li = linkInputs(cap.ldArgs, cap.cwd, cap.triple);
    const t0 = performance.now();
    const res = resolve(li.inputs, li.roots, li.plan.wraps);
    const resolveMs = performance.now() - t0;

    const ld = cap.trace;
    const mine = res.order;
    const ldSet = new Set(ld);
    const mySet = new Set(mine);
    const missing = ld.filter((x) => !mySet.has(x));
    const extra = mine.filter((x) => !ldSet.has(x));
    const orderEqual = missing.length === 0 && extra.length === 0 && ld.every((x, i) => x === mine[i]);

    // Repack.
    const miniDir = join(dir, `${tag}mini`);
    rmSync(miniDir, { recursive: true, force: true });
    const replaced = new Map<string, string | null>();
    let miniBytes = 0;
    let fullArchiveBytes = 0;
    let k = 0;
    for (const inp of li.inputs) {
        if (inp.kind !== "archive" || replaced.has(inp.path)) continue;
        const abs = li.abs.get(inp.path)!;
        const a = loadArchive(abs, cap.triple);
        fullArchiveBytes += readFileSync(packArchivePath(abs, cap.triple)).length;
        const sel = res.members.get(inp.path) ?? [];
        if (!sel.length) { replaced.set(inp.path, null); continue; }
        const remap = new Map(sel.map((m, i) => [m, i]));
        const bytes = writeArchive(
            sel.map((m) => ({ name: a.members[m].name, data: a.data[m] })),
            a.armap.filter(([, m]) => remap.has(m)).map(([symbol, m]) => ({ symbol, member: remap.get(m)! })),
        );
        const sub = join(miniDir, String(k++));
        mkdirSync(sub, { recursive: true });
        const p = join(sub, basename(abs));
        writeFileSync(p, bytes);
        miniBytes += bytes.length;
        replaced.set(inp.path, p);
    }
    // New argv: each archive argument → its mini archive, or dropped.
    const argv: string[] = [];
    const a = cap.ldArgs;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        let lib: string | null = null;
        if (x === "-l") lib = `lib${a[++i]}.a`;
        else if (x.startsWith("-l")) lib = x.startsWith("-l:") ? x.slice(3) : `lib${x.slice(2)}.a`;
        if (lib) {
            const hit = [...replaced].find(([p]) => p.endsWith(`/${lib}`) && li.plan.libDirs.some((d) => p === `${d}/${lib}`));
            if (!hit) throw new Error(`no archive for ${x}`);
            if (hit[1]) argv.push(hit[1]);
        } else if (replaced.has(x)) {
            const r = replaced.get(x);
            if (r) argv.push(r);
        } else argv.push(x === "@OUT@" ? join(dir, `${tag}mini.elf`) : x);
    }
    writeFileSync(join(dir, `${tag}mini.argv.json`), JSON.stringify(argv, null, 1));
    const PATH = `${toolBin(cap.triple)}:${process.env.PATH}`;
    const r = run(cap.ldPath, [...argv, `-Map=${join(dir, `${tag}mini.map`)}`], { cwd: cap.cwd, env: { ...process.env, PATH, ...cap.ldEnv } });
    let elfIdentical = false;
    let imageIdentical = false;
    if (r.code !== 0) {
        writeFileSync(join(dir, `${tag}mini.ld.stderr.txt`), r.stderr);
        console.log(`  mini link FAILED: ${r.stderr.split("\n").slice(0, 5).join("\n  ")}`);
    } else {
        elfIdentical = Buffer.compare(readFileSync(join(dir, `${tag}mini.elf`)), readFileSync(join(dir, "pio.elf"))) === 0;
        // Flash image with pio's own post-link command.
        for (const line of cap.post) {
            const args = shellSplit(line).map((x) => x.replace(/\.pio\/build\/[^/]+\/firmware\.(elf|bin|hex)$/, (_m, ext) => join(dir, `${tag}mini.${ext}`)));
            const pr = run(args[0], args.slice(1), { cwd: cap.cwd, env: { ...process.env, PATH } });
            if (pr.code !== 0) console.log(`  post failed: ${pr.stderr.slice(0, 500)}`);
        }
        const ext = existsSync(join(dir, "pio.firmware.bin")) ? "bin" : "hex";
        imageIdentical = existsSync(join(dir, `${tag}mini.${ext}`)) && Buffer.compare(readFileSync(join(dir, `${tag}mini.${ext}`)), readFileSync(join(dir, `pio.firmware.${ext}`))) === 0;
        const again = parseMapMembers(readFileSync(join(dir, `${tag}mini.map`), "utf8"));
        if (again.length !== ld.length) console.log(`  note: mini link loaded ${again.length} members (full: ${ld.length})`);
    }
    const out: ValidateResult = { id, ldMembers: ld.length, resolved: mine.length, missing, extra, orderEqual, elfIdentical, imageIdentical, miniBytes, fullArchiveBytes, resolveMs };
    writeFileSync(join(dir, `${tag}validate.json`), JSON.stringify({ ...out, undefinedAtEnd: res.undefined }, null, 1));
    return out;
}

if (import.meta.main) {
    const ids = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(SCRATCH, "cap")).sort();
    for (const id of ids) {
        const v = validate(id);
        console.log(`${id}: ld ${v.ldMembers} / resolver ${v.resolved}, missing ${v.missing.length}, extra ${v.extra.length}, order ${v.orderEqual ? "=" : "≠"}, ELF ${v.elfIdentical ? "identical" : "DIFFERS"}, image ${v.imageIdentical ? "identical" : "DIFFERS"}, mini ${(v.miniBytes / 1e6).toFixed(2)} MB of ${(v.fullArchiveBytes / 1e6).toFixed(1)} MB, resolve ${v.resolveMs.toFixed(0)} ms`);
        for (const m of v.missing.slice(0, 8)) console.log(`   missing ${m}`);
        for (const m of v.extra.slice(0, 8)) console.log(`   extra   ${m}`);
    }
}
