/**
 * gcc/as/ld output → diagnostics located in the caller's files. Paths are mapped like the AI
 * Hub's former server build did (app-runner's `parseBuildLog`, since removed): the sketch's
 * own files by the name the caller used, the generated `.ino.cpp` to the main `.ino`,
 * PlatformIO package and library paths shortened.
 */
import type { Diagnostic } from "./types";

const DIAG_RE = /^(.+?):(\d+):(?:(\d+):)? (fatal error|error|warning): (.*)$/;
const UNDEFINED_RE = /undefined reference to (.+)$/;
const LD_ERROR_RE = /^\S*\bld: (?!warning)(.+)$/;
const MAX_DIAGNOSTICS = 50;

export interface DiagnosticContext {
    /** Absolute project dir in the virtual FS ("/work/project"). */
    cwd: string;
    /** "src/<path>" → the path the caller sent. */
    paths: Map<string, string>;
    /** The caller's path of the main .ino (for the generated .ino.cpp), if any. */
    mainIno: string | null;
    /** Prefixes stripped from library/package paths ("/opt/pio/packages/", "/opt/pio-libs/<dir>/"). */
    strip: RegExp[];
}

export function mapPath(raw: string, ctx: DiagnosticContext): string | null {
    let p = raw.trim();
    if (p.startsWith(ctx.cwd + "/")) p = p.slice(ctx.cwd.length + 1);
    p = p.replace(/^\.\//, "");
    if (ctx.paths.has(p)) return ctx.paths.get(p)!;
    if (/\.ino\.cpp$/.test(p) && ctx.mainIno) return ctx.mainIno;
    for (const re of ctx.strip) p = p.replace(re, "");
    return p || null;
}

export function parseDiagnostics(log: string, ctx: DiagnosticContext): { errors: Diagnostic[]; warnings: Diagnostic[] } {
    const own = new Set(ctx.paths.values());
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    const seen = new Set<string>();
    const push = (list: Diagnostic[], d: Diagnostic) => {
        const key = `${list === errors ? "e" : "w"}|${d.file}|${d.line}|${d.column}|${d.message}`;
        if (seen.has(key) || list.length >= MAX_DIAGNOSTICS) return;
        seen.add(key);
        list.push(d);
    };
    for (const raw of log.split(/\r?\n/)) {
        const line = raw.trimEnd();
        let m: RegExpExecArray | null;
        if ((m = UNDEFINED_RE.exec(line))) {
            push(errors, { file: null, line: null, column: null, message: `undefined reference to ${m[1]!.trim()}` });
            continue;
        }
        if ((m = DIAG_RE.exec(line))) {
            const file = mapPath(m[1]!, ctx);
            const d: Diagnostic = { file, line: Number(m[2]), column: m[3] ? Number(m[3]) : null, message: m[5]!.trim() };
            if (m[4] === "warning") {
                // Warnings from the core and libraries are noise for the sketch author.
                if (file && own.has(file)) push(warnings, d);
            } else push(errors, d);
            continue;
        }
        if ((m = LD_ERROR_RE.exec(line)) && !/: in function /.test(line) && !/^\s/.test(line)) {
            push(errors, { file: null, line: null, column: null, message: m[1]!.trim() });
        }
    }
    return { errors, warnings };
}
