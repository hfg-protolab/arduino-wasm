/**
 * A registry package → the library builder PlatformIO would make of it (port of
 * platformio/builder/tools/piolib.py, PlatformIO 6.2.0): which builder class (PlatformIO /
 * Arduino / Unknown, `build.builder` overrides), its include dirs, source dir and src_filter,
 * build flags, LDF and compatibility modes, archiving — and the `LibraryEntry` the runtime LDF
 * (src/ldf.ts) reads, with the scan data the pack builder writes for pack libraries.
 */
import { scanIncludes } from "../ldf";
import type { LibraryEntry } from "../manifest";
import { itemsInList, LIBRARY_MANIFEST_NAMES, parseManifestBytes, type LibDependency, type LibManifest } from "./manifest";
import { matchSrcFiles, SRC_BUILD_EXT, SRC_HEADER_EXT, endsWithExt } from "./srcfilter";

export type BuilderKind = "platformio" | "arduino" | "mbed" | "unknown";

/** How PlatformIO builds the library (what the LDF does not need). */
export interface LibBuild {
    kind: BuilderKind;
    /** Library root, virtual absolute ("/work/project/.pio/libdeps/uno/Foo"). */
    root: string;
    /** The same root as PlatformIO prints it on the command line (relative to the project). */
    cliRoot: string;
    /** Source dir relative to the root ("" or "src"). */
    srcDir: string;
    /** Sources to build, relative to the source dir, sorted. */
    sources: string[];
    /** Extra compiler flags of library.json `build.flags` (not -I, which are include dirs). */
    flags: string[];
    unflags: string[];
    /** `lib_archive` of this library (undefined: the board's default). */
    libArchive?: boolean;
    /** `.pio/build/<env>/lib<sha1(path)[:3]>/<dir name>`, filled by the caller (needs sha1). */
    files: Map<string, Uint8Array>;
}

export interface RegistryLibrary {
    entry: LibraryEntry;
    build: LibBuild;
    manifest: LibManifest;
    /** Why PlatformIO would not use it on this board (soft compat mode: frameworks), if so. */
    incompatible?: string;
    /** Something this compiler cannot do with it (extraScript, precompiled, …). */
    unsupported?: string;
}

const SCAN_RE = /\.(h|hh|hpp|hxx|inc|tcc|ipp|c|cc|cpp|cxx|c\+\+|S|ino)$/;
const dec = new TextDecoder("utf-8");

const normRel = (p: string) => {
    const out: string[] = [];
    for (const s of p.split("/")) {
        if (!s || s === ".") continue;
        if (s === "..") out.pop();
        else out.push(s);
    }
    return out.join("/");
};

/**
 * PlatformIO's package root: the archive root when it holds a library manifest, else the first
 * directory (os.walk order: top-down, sorted here) that does.
 */
export function packageRoot(paths: string[]): string {
    const dirs = new Set<string>([""]);
    for (const p of paths) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    const has = new Set(paths);
    const ordered = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
    for (const d of ordered) if (LIBRARY_MANIFEST_NAMES.some((n) => has.has(d ? `${d}/${n}` : n))) return d;
    return "";
}

/** PlatformIO's `get_safe_dirname`. */
export const safeDirName = (name: string) => name.replace(/[^\da-z_\-. ]/gi, "_");

/** Shell-like split of build flags (SCons ParseFlags uses shlex). */
export function splitFlags(v: string | string[] | undefined): string[] {
    if (!v) return [];
    const s = Array.isArray(v) ? v.join(" ") : v;
    const out: string[] = [];
    let cur = "";
    let q: string | null = null;
    let has = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        if (q) {
            if (c === q) q = null;
            else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
            else cur += c;
        } else if (c === '"' || c === "'") {
            q = c;
            has = true;
        } else if (c === "\\" && i + 1 < s.length) cur += s[++i];
        else if (/\s/.test(c)) {
            if (cur || has) out.push(cur);
            cur = "";
            has = false;
        } else cur += c;
    }
    if (cur || has) out.push(cur);
    return out;
}

export interface LibraryContext {
    /** Board's PIOFRAMEWORK, e.g. ["arduino"]. */
    frameworks: string[];
    platform: string;
    /** Storage dir, virtual absolute ("/work/project/.pio/libdeps/uno"). */
    storage: string;
    /** The same as PlatformIO prints it (".pio/libdeps/uno"). */
    cliStorage: string;
    /** Rank of the library in GetLibBuilders() order. */
    order: number;
}

/**
 * @param files the package's files relative to the package root (packageRoot applied)
 * @param meta name/version/owner as the package manager recorded them (.piopm)
 */
export function libraryFromPackage(files: Map<string, Uint8Array>, meta: { name: string; version: string; owner?: string; dirName: string }, ctx: LibraryContext): RegistryLibrary {
    const paths = [...files.keys()];
    const has = (p: string) => files.has(p);
    const isDir = (p: string) => paths.some((f) => f.startsWith(`${p}/`));
    const root = `${ctx.storage}/${meta.dirName}`;
    const cliRoot = `${ctx.cliStorage}/${meta.dirName}`;

    // LibBuilderFactory.new
    let kind: BuilderKind = "unknown";
    let manifest: LibManifest = { type: "library.json" };
    const load = (n: "library.json" | "library.properties" | "module.json") => {
        try {
            return parseManifestBytes(n, files.get(n)!);
        } catch {
            return { type: n } as LibManifest; // "Ignoring broken library manifest"
        }
    };
    if (has("library.json")) {
        kind = "platformio";
        manifest = load("library.json");
    } else {
        const used = usedFrameworks(files);
        const common = used.filter((f) => ctx.frameworks.includes(f));
        const fw = common[0] ?? used[0];
        if (fw === "arduino") kind = "arduino";
        else if (fw === "mbed") kind = "mbed";
        if (kind === "arduino" && has("library.properties")) manifest = load("library.properties");
        if (kind === "mbed" && has("module.json")) manifest = load("module.json");
    }
    const builderOverride = manifest.build?.builder;
    if (kind === "platformio" && builderOverride) {
        const k = { PlatformIOLibBuilder: "platformio", ArduinoLibBuilder: "arduino", MbedLibBuilder: "mbed", UnknownLibBuilder: "unknown" }[builderOverride] as BuilderKind | undefined;
        if (k) {
            kind = k;
            if (k === "arduino") manifest = has("library.properties") ? load("library.properties") : { type: "library.properties" };
        }
    }
    const b = manifest.build ?? {};
    const isPio = kind === "platformio";

    // src_dir / include_dir
    const relOf = (p: string) => normRel(p);
    let srcDir = isPio && b.srcDir !== undefined ? relOf(b.srcDir) : isDir("src") ? "src" : isDir("Src") ? "Src" : "";
    if (kind === "mbed" && isDir("source")) srcDir = "source";
    let includeDir: string | null = null;
    if (isPio && b.includeDir !== undefined) includeDir = relOf(b.includeDir);
    else if (kind === "arduino") includeDir = isDir("include") && isDir("src") ? "include" : null;
    else includeDir = isDir("include") ? "include" : isDir("Include") ? "Include" : null;

    // build flags (ProcessFlags): -I → CPPPATH (include dirs), the rest stays flags
    const flagList = isPio ? splitFlags(b.flags) : [];
    const flags: string[] = [];
    const extraInc: string[] = [];
    for (let i = 0; i < flagList.length; i++) {
        const f = flagList[i]!;
        if (f === "-I" && i + 1 < flagList.length) extraInc.push(relOf(flagList[++i]!));
        else if (f.startsWith("-I")) extraInc.push(relOf(f.slice(2)));
        else flags.push(f);
    }
    const unflags = isPio ? splitFlags(b.unflags) : [];

    const incRel: string[] = [];
    if (includeDir !== null) incRel.push(includeDir);
    incRel.push(srcDir);
    if (kind === "arduino" && !isDir("src") && isDir("utility")) incRel.push("utility");
    if (isPio && !manifest.build && has("library.properties") && !isDir("src") && isDir("utility")) incRel.push("utility");
    if (kind === "mbed" && !incRel.includes("")) incRel.push("");
    for (const d of extraInc) if (!incRel.includes(d)) incRel.push(d);
    const abs = (r: string) => (r ? `${root}/${r}` : root);
    const cli = (r: string) => (r ? `${cliRoot}/${r}` : cliRoot);

    // src_filter
    const baseFilter = ["+<*>", "-<.git/>", "-<.svn/>", "-<example/>", "-<examples/>", "-<test/>", "-<tests/>"];
    const arduinoFilter = (): string[] => {
        if (isDir("src")) {
            const f = [...baseFilter];
            const dirsWithAsm = new Set<string>();
            for (const p of paths) if (p.startsWith("src/") && p.toLowerCase().endsWith("asm")) dirsWithAsm.add(p.slice(4, p.lastIndexOf("/") + 1));
            for (const d of [...dirsWithAsm].sort()) f.push(`-<${d}*.[aA][sS][mM]>`);
            return f;
        }
        const f: string[] = [];
        const utility = isDir("utility");
        for (const ext of [...SRC_BUILD_EXT, ...SRC_HEADER_EXT]) {
            if (ext.toLowerCase() === "asm") continue;
            f.push(`+<*.${ext}>`);
            if (utility) f.push(`+<utility/*.${ext}>`);
        }
        return f;
    };
    let srcFilter: string | string[];
    if (kind === "arduino") srcFilter = arduinoFilter();
    else if (isPio && b.srcFilter !== undefined) srcFilter = b.srcFilter;
    else if (isPio && has("library.properties")) srcFilter = arduinoFilter();
    else srcFilter = baseFilter;
    const sources = matchSrcFiles(paths, srcDir, srcFilter, SRC_BUILD_EXT);

    // LDF scan data
    const scanFiles: Record<string, string[]> = {};
    const key = (i: { name: string; quoted: boolean }) => `${i.quoted ? '"' : "<"} ${i.name}`;
    for (const [p, data] of files) {
        if (!SCAN_RE.test(p)) continue;
        const incs = scanIncludes(dec.decode(data)).sort((a, c) => (key(a) < key(c) ? -1 : key(a) > key(c) ? 1 : 0));
        scanFiles[p] = incs.map((i) => (i.quoted ? '"' : "<") + i.name);
    }
    const ldfMode = isPio ? validateLdfMode(b.libLDFMode) : undefined;
    const compatMode = isPio ? b.libCompatMode : undefined;

    let incompatible: string | undefined;
    if (kind === "mbed") incompatible = "an mbed library";
    else if (kind === "platformio" && (compatMode ?? "soft") !== "off" && manifest.frameworks?.length && !itemsInList(ctx.frameworks, manifest.frameworks)) incompatible = `frameworks ${manifest.frameworks.join(", ")}`;
    else if (compatMode === "strict" && manifest.platforms?.length && !itemsInList(ctx.platform, manifest.platforms)) incompatible = `platforms ${manifest.platforms.join(", ")}`;

    let unsupported: string | undefined;
    if (isPio && b.extraScript) unsupported = `library.json build.extraScript (${b.extraScript}) runs Python at build time`;
    else if (kind === "arduino" && (manifest.properties?.precompiled === "true" || manifest.properties?.precompiled === "full")) unsupported = "precompiled library (library.properties precompiled=true)";
    else if (flags.some((f) => /^-(l|L|Wl,)/.test(f))) unsupported = `linker flags in build.flags (${flags.filter((f) => /^-(l|L|Wl,)/.test(f)).join(" ")})`;

    const topDir = includeDir ?? srcDir;
    const headers = paths.filter((p) => (topDir ? p.startsWith(`${topDir}/`) && !p.slice(topDir.length + 1).includes("/") : !p.includes("/")) && endsWithExt(p, SRC_HEADER_EXT)).map((p) => (topDir ? p.slice(topDir.length + 1) : p));
    const deps = kind === "platformio" ? (manifest.dependencies ?? []) : [];
    const entry: LibraryEntry = {
        name: (manifest.name as string | undefined) ?? meta.name,
        version: meta.version,
        ...(meta.owner ? { owner: meta.owner } : {}),
        origin: "registry",
        includeDirs: incRel.map(cli),
        headers,
        deps: [],
        scan: {
            root,
            files: scanFiles,
            sources: sources.map((s) => (srcDir ? `${srcDir}/${s}` : s)),
            order: ctx.order,
            ...(ldfMode ? { ldfMode } : {}),
            ...(deps.length ? { dependencies: deps } : {}),
            absIncludeDirs: incRel.map(abs),
            pkgName: meta.name,
        },
    };
    return {
        entry,
        build: { kind, root, cliRoot, srcDir, sources, flags, unflags, ...(isPio && b.libArchive !== undefined ? { libArchive: !!b.libArchive } : {}), files },
        manifest,
        ...(incompatible ? { incompatible } : {}),
        ...(unsupported ? { unsupported } : {}),
    };
}

const LDF_MODES = ["off", "chain", "deep", "chain+", "deep+"];
function validateLdfMode(m: unknown): string | undefined {
    if (m === undefined || m === null) return undefined;
    const s = String(m).trim().toLowerCase();
    if (LDF_MODES.includes(s)) return s;
    const n = Number(s);
    if (Number.isInteger(n) && n >= 0 && n < LDF_MODES.length) return LDF_MODES[n];
    return "chain";
}

/** LibBuilderFactory.get_used_frameworks */
function usedFrameworks(files: Map<string, Uint8Array>): string[] {
    if (files.has("library.properties") || files.has("keywords.txt")) return ["arduino"];
    if (files.has("module.json")) return ["mbed"];
    const re = /^#include\s+(<|")(Arduino|mbed)\.h(<|")/m;
    for (const [p, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (p.endsWith("/mbed_lib.json") || p === "mbed_lib.json") return ["mbed"];
        if (!endsWithExt(p, [...SRC_BUILD_EXT, ...SRC_HEADER_EXT])) continue;
        const text = dec.decode(data);
        if (text.includes("Arduino.h") && re.test(text) && /Arduino\.h/.test(re.exec(text)![0])) return ["arduino"];
        if (text.includes("mbed.h") && re.test(text)) return ["mbed"];
    }
    return [];
}

export type { LibDependency };
