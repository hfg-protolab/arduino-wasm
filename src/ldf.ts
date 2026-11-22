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
import { isCompatible } from "./registry/manifest";
import { castVersion, isValidSpec, SimpleSpec } from "./registry/semver";
import { parseLibSpec, type LibSpec } from "./registry/spec";
import type { SourceFile } from "./types";

export interface LdfResult {
    /** Selected libraries in link order (post-order). */
    libraries: LibraryEntry[];
    /** `-I` arguments for the compile line, in PlatformIO's order. */
    includeArgs: string[];
    /** Includes that matched neither a project file nor a library (resolved by the compiler, or an error). */
    unresolved: string[];
    /** `-I` arguments of each selected library's own compile line (PlatformIO's library CPPPATH). */
    libIncludeArgs?: Map<LibraryEntry, string[]>;
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
export function selectLibraries(files: SourceFile[], libraries: LibraryEntry[], opts: LdfOptions = {}): LdfResult {
    if (libraries.length && libraries.every((l) => l.scan)) return selectLibrariesPio(files, libraries, opts);
    return selectLibrariesByGraph(files, libraries);
}

/** Older packs (no `scan` data): the dependency graph of the pack's probe build. */
function selectLibrariesByGraph(files: SourceFile[], libraries: LibraryEntry[]): LdfResult {
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

// ---------------------------------------------------------------------------------------------
// PlatformIO's LDF, step by step (platformio/builder/tools/piolib.py, lib_ldf_mode = chain, the
// classic SCons scanner). Needed where the ORDER of a library's dependencies matters: pioarduino
// links library objects one by one, in build order, so "SPI before Wire" changes the image.
//
// - The project scans all its sources (deep). Each found include goes to the library builder
//   that contains the file, with that file as the library's search file.
// - depend_on(lb, files): lb is appended to depbuilders (first come, first linked), then lb scans
//   exactly those files (and its own files they include; for a header X.h also X.c/X.cpp next to
//   it), recursively. A library's processed files are remembered across calls.
// - Afterwards (chain mode) every found library scans all its source files once more
//   (_correct_found_libs), which can append further dependencies.
// - Build order = post-order over depbuilders; that is the link order of objects/archives.
// - Includes resolve like SCons: "x" in the file's dir first, then the builder's own include
//   dirs, then the project's and every library's include dirs (dependent libraries first);
//   <x> the same without the file's dir first (it comes last).

const PROJECT = "@src";
const HEADER_RE = /\.(h|hpp)$/;
const SRC_EXTS = ["c", "cc", "cpp", "cxx", "c++"];

interface Builder {
    lib: LibraryEntry | null;
    root: string;
    /** Include dirs, absolute (LDF resolution). */
    incDirs: string[];
    /** Include dirs as the compile line prints them. */
    cliDirs: string[];
    order: number;
    processed: Set<string>;
    deps: Builder[];
    circular: Builder[];
    dependent: boolean;
    built: boolean;
    depsProcessed: boolean;
    env: string[] | null;
}

export interface LdfOptions {
    /** The project's `lib_deps` (raw specs): PlatformIO's ProjectAsLibBuilder.process_dependencies. */
    libDeps?: string[];
}

const normAbs = (p: string) => {
    const lead = p.startsWith("/") ? "/" : "";
    const parts: string[] = [];
    for (const s of p.split("/")) {
        if (!s || s === ".") continue;
        if (s === "..") parts.pop();
        else parts.push(s);
    }
    return lead + parts.join("/");
};

/** SCons PrependUnique of a list: the new items (in order, once) before the existing ones. */
export function prependUnique(list: string[], items: string[]): string[] {
    const add: string[] = [];
    for (const x of items) if (!list.includes(x) && !add.includes(x)) add.push(x);
    return [...add, ...list];
}

const ciEq = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

function selectLibrariesPio(files: SourceFile[], libraries: LibraryEntry[], opts: LdfOptions = {}): LdfResult {
    const projectPath = (p: string) => `${PROJECT}/${norm(p.replace(/^src\//, ""))}`;
    const includesOf = new Map<string, Array<{ name: string; quoted: boolean }>>();
    const sortKey = (i: { name: string; quoted: boolean }) => `${i.quoted ? '"' : "<"} ${i.name}`;
    const sorted = (incs: Array<{ name: string; quoted: boolean }>) => incs.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    const exists = new Set<string>();
    for (const f of files) {
        const p = projectPath(f.path);
        exists.add(p);
        includesOf.set(p, sorted(scanIncludes(f.content)));
    }
    const builders: Builder[] = libraries.map((l) => ({
        lib: l,
        root: l.scan!.root,
        incDirs: l.scan!.absIncludeDirs ?? l.includeDirs,
        cliDirs: l.includeDirs,
        order: l.scan!.order,
        processed: new Set(),
        deps: [],
        circular: [],
        dependent: false,
        built: false,
        depsProcessed: false,
        env: null,
    }));
    for (const b of builders) {
        for (const [rel, incs] of Object.entries(b.lib!.scan!.files)) {
            const p = `${b.root}/${rel}`;
            exists.add(p);
            includesOf.set(p, incs.map((x) => ({ name: x.slice(1), quoted: x[0] === '"' })));
        }
    }
    const base = [...builders].sort((a, b) => a.order - b.order);
    const project: Builder = { lib: null, root: PROJECT, incDirs: [PROJECT], cliDirs: [], order: -1, processed: new Set(), deps: [], circular: [], dependent: false, built: false, depsProcessed: true, env: null };
    const inBuilder = (b: Builder, p: string) => p.startsWith(b.root + "/");
    /** GetLibBuilders(): dependent builders first, otherwise PlatformIO's order. */
    const libBuilders = () => [...base].sort((a, b) => (a.dependent === b.dependent ? 0 : a.dependent ? -1 : 1));
    let cache: string[] | null = null;
    const unresolved: string[] = [];
    const modeOf = (b: Builder) => (b === project ? "deep" : (b.lib!.scan!.ldfMode ?? "chain"));

    const implicitIncludes = (self: Builder, searchFiles: string[]): string[] => {
        if (!cache) cache = [PROJECT, ...libBuilders().flatMap((b) => b.incDirs)];
        const dirs = [...self.incDirs, ...cache];
        const result: string[] = [];
        const queue = [...searchFiles];
        while (queue.length) {
            const file = queue.shift()!;
            if (self.processed.has(file)) continue;
            self.processed.add(file);
            for (const inc of includesOf.get(file) ?? []) {
                const here = file.slice(0, file.lastIndexOf("/"));
                const order = inc.quoted ? [here, ...dirs] : [...dirs, here];
                const found = order.map((d) => normAbs(`${d}/${inc.name}`)).find((p) => exists.has(p));
                if (!found) {
                    if (self === project && !unresolved.includes(inc.name)) unresolved.push(inc.name);
                    continue;
                }
                if (!self.processed.has(found) && !queue.includes(found) && inBuilder(self, found)) queue.push(found);
                if (!result.includes(found)) result.push(found);
                if (!HEADER_RE.test(found)) continue;
                const stem = found.slice(0, found.lastIndexOf("."));
                for (const ext of SRC_EXTS) {
                    const c = `${stem}.${ext}`;
                    if (exists.has(c) && !result.includes(c)) result.push(c);
                }
            }
        }
        return result;
    };

    const alreadyDepends = (b: Builder, self: Builder, seen = new Set<Builder>()): boolean => {
        if (seen.has(b)) return false;
        seen.add(b);
        return b.deps.includes(self) || b.deps.some((d) => alreadyDepends(d, self, seen));
    };

    const dependOn = (self: Builder, lb: Builder, searchFiles: string[] | undefined, recursive = true) => {
        if (self !== lb) {
            if (alreadyDepends(lb, self)) self.circular.push(lb);
            else if (!self.deps.includes(lb)) {
                self.deps.push(lb);
                lb.dependent = true;
                cache = null;
            }
        }
        if (recursive) searchDeps(lb, searchFiles);
    };

    /** LibBuilderBase.is_dependency_compatible */
    const dependencyCompatible = (lb: Builder, dep: { owner?: string; name: string; version?: string }) => {
        const l = lb.lib!;
        const have: Record<string, unknown> = { name: l.scan?.pkgName ?? l.name, version: l.version, ...(l.owner ? { owner: l.owner } : {}) };
        const want: Record<string, unknown> = { name: dep.name };
        if (dep.owner) want.owner = dep.owner;
        if (dep.version && isValidSpec(dep.version)) want.version = dep.version;
        return isCompatible(want, have);
    };

    /** PlatformIOLibBuilder.process_dependencies (library.json `dependencies`) */
    const processDependencies = (self: Builder) => {
        const deps = self.lib?.scan?.dependencies;
        if (!deps?.length || self.depsProcessed) return;
        self.depsProcessed = true;
        for (const dep of deps) {
            const lb = libBuilders().find((x) => dependencyCompatible(x, dep));
            if (lb && !self.deps.includes(lb)) dependOn(self, lb, undefined);
        }
    };

    const searchDeps = (self: Builder, searchFiles: string[] | undefined) => {
        processDependencies(self);
        const mode = modeOf(self);
        if (mode === "off") return;
        if (mode.startsWith("deep") && self !== project) searchFiles = self.lib!.scan!.sources.map((s) => `${self.root}/${s}`);
        const map = new Map<Builder, string[]>();
        for (const inc of implicitIncludes(self, searchFiles ?? [])) {
            const owner = libBuilders().find((b) => inBuilder(b, inc));
            if (!owner) continue;
            if (!map.has(owner)) map.set(owner, []);
            map.get(owner)!.push(inc);
        }
        for (const [lb, fs] of map) dependOn(self, lb, fs);
    };

    // ProjectAsLibBuilder.process_dependencies: lib_deps by package spec (storage order), else by name
    const storageOf = (b: Builder) => b.root.slice(0, b.root.lastIndexOf("/"));
    const storages: string[] = [];
    for (const b of base) if (!storages.includes(storageOf(b))) storages.push(storageOf(b));
    const foundLbs: Builder[] = [];
    for (const raw of opts.libDeps ?? []) {
        let spec: LibSpec | null = null;
        try {
            spec = parseLibSpec(raw);
        } catch {
            spec = null;
        }
        let found = false;
        if (spec && !spec.uri && spec.name) {
            const req = spec.requirements ? new SimpleSpec(spec.requirements) : null;
            for (const st of storages) {
                const cands = base.filter((b) => {
                    if (storageOf(b) !== st) return false;
                    const l = b.lib!;
                    if (spec!.owner && !ciEq(spec!.owner, l.owner)) return false;
                    if (!ciEq(spec!.name, l.scan?.pkgName ?? l.name)) return false;
                    return !req || (l.version ? req.match(castVersion(l.version)) : false);
                });
                if (!cands.length) continue;
                const best = cands.reduce((a, b) => (castVersion(b.lib!.version ?? "0.0.0").compare(castVersion(a.lib!.version ?? "0.0.0")) > 0 ? b : a));
                if (!project.deps.includes(best)) {
                    dependOn(project, best, undefined, false);
                    foundLbs.push(best);
                }
                found = true;
                break;
            }
        }
        if (found) continue;
        const byName = libBuilders().find((b) => b.lib!.name === raw);
        if (byName && !project.deps.includes(byName)) dependOn(project, byName, undefined);
    }
    for (const lb of foundLbs) searchDeps(lb, undefined);

    // the project: every source file (deep), in the given order
    searchDeps(
        project,
        files.filter((f) => /\.(c|cc|cpp|cxx|ino|pde|S)$/i.test(f.path)).map((f) => projectPath(f.path)),
    );
    // _correct_found_libs
    if (project.deps.length) {
        const found = base.filter((b) => b.dependent);
        for (const b of base) if (found.includes(b)) searchDeps(b, b.lib!.scan!.sources.map((s) => `${b.root}/${s}`));
        const found2 = new Set(base.filter((b) => b.dependent));
        for (const b of base) b.deps = b.deps.filter((d) => found2.has(d));
        project.deps = project.deps.filter((d) => found2.has(d));
    }

    // build(): post-order link list; CPPPATH by SCons PrependUnique like LibBuilderBase.build
    const post: LibraryEntry[] = [];
    const build = (b: Builder, stack: Set<Builder>): string[] => {
        if (b.env) return b.env;
        if (stack.has(b)) return [];
        stack.add(b);
        let env: string[] = [];
        for (const d of b.deps) env = prependUnique(env, build(d, stack));
        for (const c of b.circular) env = prependUnique(env, c.cliDirs);
        stack.delete(b);
        env = prependUnique(env, b.cliDirs);
        b.env = env;
        if (!b.built) {
            b.built = true;
            post.push(b.lib!);
        }
        return env;
    };
    let projEnv: string[] = [];
    for (const b of project.deps) projEnv = prependUnique(projEnv, build(b, new Set()));
    const includeArgs = projEnv.flatMap((d) => ["-I", d]);
    const libIncludeArgs = new Map<LibraryEntry, string[]>();
    for (const b of builders) if (b.env) libIncludeArgs.set(b.lib!, b.env.flatMap((d) => ["-I", d]));
    return { libraries: post, includeArgs, unresolved, libIncludeArgs };
}
