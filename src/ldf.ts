/**
 * Library Dependency Finder, modelled on PlatformIO's `lib_ldf_mode = chain`:
 *
 * - The project's source files are scanned in path order (conditionals are not evaluated, as in
 *   chain mode). The includes of one file are taken in SCons' order: sorted by `" name` /
 *   `< name` (the classic scanner sorts by bracket + name), NOT in source order. An include
 *   that names one of the project's own files queues that file behind the ones still to scan
 *   (PlatformIO's search_files list), unless it was scanned or queued already.
 * - Any other include that names a header of a library (`LibraryEntry.headers`, first library in
 *   manifest order wins) selects that library. Libraries are recorded in discovery order: that
 *   is the top level of PlatformIO's dependency graph (e.g. `<SPI.h>`, `<Wire.h>`,
 *   `<Adafruit_GFX.h>` → GFX, SPI, Wire).
 * - A library brings its dependencies (`deps`, as PlatformIO's dependency graph listed them).
 *
 * PlatformIO links the libraries in depth-first post-order of that graph (dependencies before
 * dependents) and puts their include directories on the command line in the reverse order;
 * `selectLibraries` returns both orders.
 */
import type { LibraryEntry } from "./manifest";
import type { SourceFile } from "./types";

export interface LdfResult {
    /** Selected libraries in link order (post-order). */
    libraries: LibraryEntry[];
    /** `-I` arguments for the compile line, in PlatformIO's order. */
    includeArgs: string[];
    /** Includes that matched neither a project file nor a library (resolved by the compiler, or an error). */
    unresolved: string[];
}

/** `#include` names of a C/C++ source, in order; comments are skipped, strings respected. */
export function scanIncludes(text: string): Array<{ name: string; quoted: boolean }> {
    const out: Array<{ name: string; quoted: boolean }> = [];
    // Remove comments without touching string/char literals.
    let clean = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        const n = text[i + 1];
        if (c === "/" && n === "*") {
            const e = text.indexOf("*/", i + 2);
            const end = e < 0 ? text.length : e + 2;
            clean += text.slice(i, end).replace(/[^\n]/g, " ");
            i = end - 1;
        } else if (c === "/" && n === "/") {
            let e = text.indexOf("\n", i);
            if (e < 0) e = text.length;
            i = e - 1;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
            clean += text.slice(i, j + 1);
            i = j;
        } else clean += c;
    }
    for (const m of clean.matchAll(/^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]/gm)) {
        out.push({ name: m[2]!.trim(), quoted: m[1] === '"' });
    }
    return out;
}

const norm = (p: string) => {
    const parts: string[] = [];
    for (const s of p.split("/")) {
        if (!s || s === ".") continue;
        if (s === "..") parts.pop();
        else parts.push(s);
    }
    return parts.join("/");
};
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * @param files project files, paths relative to `src/` (the generated `.ino.cpp` included);
 *              scanned in the given order
 */
export function selectLibraries(files: SourceFile[], libraries: LibraryEntry[]): LdfResult {
    const byPath = new Map(files.map((f) => [norm(f.path.replace(/^src\//, "")), f]));
    const headerOwner = new Map<string, LibraryEntry>();
    for (const lib of libraries) for (const h of lib.headers) if (!headerOwner.has(h)) headerOwner.set(h, lib);
    const byName = new Map(libraries.map((l) => [l.name, l]));

    const found: LibraryEntry[] = [];
    const unresolved: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const f of files) if (/\.(c|cc|cpp|cxx|ino|pde|S)$/i.test(f.path)) queue.push(norm(f.path.replace(/^src\//, "")));
    const queued = new Set(queue);
    while (queue.length) {
        const path = queue.shift()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const f = byPath.get(path);
        if (!f) continue;
        const sortKey = (i: { name: string; quoted: boolean }) => `${i.quoted ? '"' : "<"} ${i.name}`;
        const incs = scanIncludes(f.content).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
        for (const inc of incs) {
            const local = [norm(`${dirOf(path)}/${inc.name}`), norm(inc.name)].find((p) => byPath.has(p));
            if (local) {
                if (!visited.has(local) && !queued.has(local)) {
                    queue.push(local);
                    queued.add(local);
                }
                continue;
            }
            const lib = headerOwner.get(norm(inc.name));
            if (lib) {
                if (!found.includes(lib)) found.push(lib);
            } else if (!unresolved.includes(inc.name)) unresolved.push(inc.name);
        }
    }

    const post: LibraryEntry[] = [];
    const seen = new Set<string>();
    const visit = (lib: LibraryEntry, stack: string[]) => {
        if (seen.has(lib.name) || stack.includes(lib.name)) return;
        for (const d of lib.deps) {
            const dep = byName.get(d);
            if (dep) visit(dep, [...stack, lib.name]);
        }
        if (!seen.has(lib.name)) {
            seen.add(lib.name);
            post.push(lib);
        }
    };
    for (const lib of found) visit(lib, []);
    const includeArgs = [...post].reverse().flatMap((l) => l.includeDirs.flatMap((d) => ["-I", d]));
    return { libraries: post, includeArgs, unresolved };
}
