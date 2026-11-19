/**
 * ld's argv → the ordered list of inputs and the switches that decide which archive members
 * get loaded (-u/--undefined, --wrap, -e/ENTRY, EXTERN, --start-group/--end-group,
 * --whole-archive). Pure; file lookup goes through `exists`, so the browser can run it
 * against the pack manifest instead of a file system.
 */

export type LdInput =
    | { kind: "object"; path: string }
    | { kind: "archive"; path: string; /** as written: "-lfoo" or a path */ arg: string; whole: boolean }
    | { kind: "script"; path: string }
    | { kind: "groupStart" }
    | { kind: "groupEnd" };

export interface LdPlan {
    inputs: LdInput[];
    undefined: string[];
    wraps: string[];
    entry: string | null;
    libDirs: string[];
    output: string | null;
}

/** Options of GNU ld that take a separate argument (subset seen in AVR/ESP32 links + common). */
const WITH_ARG = new Set(["-o", "-e", "-u", "-T", "-L", "-l", "-m", "-z", "-Map", "-plugin", "-Tdata", "-Ttext", "-Tbss", "-y", "-Y", "-R", "-F", "-f", "-h", "--entry", "--undefined", "--wrap", "--script", "--library-path", "--library", "--defsym", "--sysroot", "-a", "-A", "--section-start", "--require-defined"]);

export function parseLdArgs(argv: string[], resolveFile: (name: string, dirs: string[], isLib: boolean) => string | null): LdPlan {
    const plan: LdPlan = { inputs: [], undefined: [], wraps: [], entry: null, libDirs: [], output: null };
    // -L applies to every -l regardless of position: collect first.
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-L" || a === "--library-path") plan.libDirs.push(argv[++i]);
        else if (a.startsWith("--library-path=")) plan.libDirs.push(a.slice(15));
        else if (a.startsWith("-L")) plan.libDirs.push(a.slice(2));
    }
    let whole = false;
    const take = (i: number, a: string, opt: string): [string, number] => (a === opt ? [argv[i + 1], i + 1] : [a.slice(opt.length + (a[opt.length] === "=" ? 1 : 0)), i]);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        let v: string;
        if (a === "--start-group" || a === "-(") plan.inputs.push({ kind: "groupStart" });
        else if (a === "--end-group" || a === "-)") plan.inputs.push({ kind: "groupEnd" });
        else if (a === "--whole-archive") whole = true;
        else if (a === "--no-whole-archive") whole = false;
        else if (a === "-u" || a.startsWith("--undefined") || a.startsWith("--require-defined")) {
            [v, i] = a === "-u" ? [argv[i + 1], i + 1] : take(i, a, a.startsWith("--u") ? "--undefined" : "--require-defined");
            plan.undefined.push(v);
        } else if (a.startsWith("-u") && a.length > 2) plan.undefined.push(a.slice(2));
        else if (a === "--wrap" || a.startsWith("--wrap=")) { [v, i] = take(i, a, "--wrap"); plan.wraps.push(v); }
        else if (a === "-e" || a.startsWith("--entry")) { [v, i] = a === "-e" ? [argv[i + 1], i + 1] : take(i, a, "--entry"); plan.entry = v; }
        else if (a === "-o") plan.output = argv[++i];
        else if (a === "-T" || a.startsWith("--script")) {
            [v, i] = a === "-T" ? [argv[i + 1], i + 1] : take(i, a, "--script");
            const p = resolveFile(v, plan.libDirs, false);
            if (!p) throw new Error(`linker script not found: ${v}`);
            plan.inputs.push({ kind: "script", path: p });
        } else if (a === "-l" || (a.startsWith("-l") && a.length > 2)) {
            [v, i] = a === "-l" ? [argv[i + 1], i + 1] : [a.slice(2), i];
            const name = v.startsWith(":") ? v.slice(1) : `lib${v}.a`;
            const p = resolveFile(name, plan.libDirs, true);
            if (!p) throw new Error(`library not found: -l${v}`);
            plan.inputs.push({ kind: "archive", path: p, arg: `-l${v}`, whole });
        } else if (a.startsWith("-L") || a === "--library-path" || a.startsWith("--library-path=")) {
            if (a === "-L" || a === "--library-path") i++;
        } else if (a.startsWith("-")) {
            // Everything else does not change which members are loaded. Skip its argument.
            if (WITH_ARG.has(a)) i++;
        } else {
            const p = resolveFile(a, [], false) ?? a;
            if (p.endsWith(".a")) plan.inputs.push({ kind: "archive", path: p, arg: a, whole });
            else if (/\.(ld|x|lds)$/.test(p)) plan.inputs.push({ kind: "script", path: p });
            else plan.inputs.push({ kind: "object", path: p });
        }
    }
    return plan;
}

/** Linker-script statements that pull symbols in: ENTRY(sym), EXTERN(sym ...), INCLUDE file. */
export function scriptRoots(text: string): { entry: string | null; externs: string[]; includes: string[]; inputs: string[] } {
    const t = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    const externs: string[] = [];
    const includes: string[] = [];
    const inputs: string[] = [];
    let entry: string | null = null;
    for (const m of t.matchAll(/\bENTRY\s*\(\s*([^\s)]+)\s*\)/g)) entry = m[1];
    for (const m of t.matchAll(/\bEXTERN\s*\(([^)]*)\)/g)) externs.push(...m[1].split(/[\s,]+/).filter(Boolean));
    for (const m of t.matchAll(/^\s*INCLUDE\s+(\S+)/gm)) includes.push(m[1]);
    for (const m of t.matchAll(/\b(?:INPUT|GROUP)\s*\(([^)]*)\)/g)) inputs.push(...m[1].split(/[\s,]+/).filter(Boolean));
    return { entry, externs, includes, inputs };
}
