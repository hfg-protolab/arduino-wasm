/**
 * `lib_deps` → the packages PlatformIO 6.2 installs into `.pio/libdeps/<env>`, in the same order
 * and versions (platformio/package/manager/_install.py, _registry.py, library.py and
 * package/commands/install.py `_install_project_env_libraries`, then piolib's
 * `ProjectAsLibBuilder.install_dependencies`):
 *
 * 1. Every lib_deps spec WITH an owner (owner-less ones are "built-in" hints here) is installed
 *    with the env's compatibility (platform, framework): the package by owner/name, the highest
 *    version matching the requirements; then its manifest dependencies, depth-first. A dependency
 *    whose own platforms/frameworks qualifiers exclude the env is skipped; an owner-less one named
 *    like a framework library (`builtinNames`) is skipped; otherwise it is searched by name
 *    (+ its platforms/frameworks/authors qualifiers) — a dependency that is not found only warns.
 *    A spec already satisfied by an installed package is not installed again.
 * 2. Every lib_deps spec not equal to a library name and not satisfied by any storage (pack
 *    libraries, libdeps) is installed by registry search (no env compatibility).
 *
 * Packages get the directory PlatformIO gives them (`get_safe_dirname`; a second version of the
 * same name is "detached" to `<name>@<version>`).
 */
import type { LibraryEntry } from "../manifest";
import { RegistryUnreachableError, type RegistryClient, type RegistryFile, type RegistryPackage, type RegistryVersion } from "./client";
import { isCompatible, LIBRARY_MANIFEST_NAMES, parseManifestBytes, type LibDependency, type LibManifest } from "./manifest";
import { castVersion, SimpleSpec, type Version } from "./semver";
import { humanizeLibSpec, parseLibSpec, type LibSpec } from "./spec";
import { gunzip, readTar } from "./tar";
import { packageRoot, safeDirName } from "./library";

import type { LibraryProblem } from "../types";
export type { LibraryProblem };

/** The English one-line message of a problem (a diagnostic with `file: null`). */
export function problemMessage(p: LibraryProblem): string {
    switch (p.kind) {
        case "libNotFound":
            return `library "${p.spec}" not found`;
        case "libVersion":
            return `library "${p.spec}": no version matches (available: ${p.available.join(", ")})`;
        case "libIncompatible":
            return `library "${p.spec}" does not support platform "${p.platform}"`;
        case "libUnsupported":
            return `library "${p.spec}" is not supported: ${p.reason}`;
        case "registryUnreachable":
            return "registry unreachable";
    }
}

export class LibraryProblemError extends Error {
    constructor(readonly problem: LibraryProblem) {
        super(problemMessage(problem));
        this.name = "LibraryProblemError";
    }
}

export interface InstalledPackage {
    owner: string;
    /** Registry package name (metadata name = manifest name, else this). */
    name: string;
    version: string;
    dirName: string;
    sha256: string;
    file: RegistryFile;
    /** Files relative to the package root. */
    files: Map<string, Uint8Array>;
    manifest: LibManifest | null;
    /** The lib_deps line (or dependency) that brought it in. */
    requestedBy: string;
    /** Directly listed in lib_deps. */
    direct: boolean;
}

export interface ResolveContext {
    client: RegistryClient;
    platform: string;
    frameworks: string[];
    builtinNames: string[];
    /** Pack libraries (lib_extra_dirs + framework): phase 2 looks for specs there first. */
    packLibraries: LibraryEntry[];
    /** A package starts downloading (label = its name) / bytes of it arrived. */
    onDownload?: (label: string, size: number) => void;
    onBytes?: (n: number) => void;
}

export interface ResolveResult {
    packages: InstalledPackage[];
    warnings: string[];
}

const ciEq = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const vOf = (s: string) => castVersion(s);

/** PackageSpec of a dependency dict (`dependency_to_spec`); null when its version is not a valid spec. */
function depSpec(d: LibDependency): LibSpec | null {
    try {
        if (d.version) new SimpleSpec(d.version);
        return { raw: "", ...(d.owner ? { owner: d.owner } : {}), name: d.name, ...(d.version ? { requirements: d.version } : {}) };
    } catch {
        return null;
    }
}

function satisfies(spec: LibSpec, pkg: { owner?: string; name: string; version?: string }): boolean {
    if (spec.owner && !ciEq(spec.owner, pkg.owner)) return false;
    if (!spec.owner && !ciEq(spec.name, pkg.name)) return false;
    if (spec.owner && !ciEq(spec.name, pkg.name)) return false;
    if (spec.requirements) {
        if (!pkg.version) return false;
        return new SimpleSpec(spec.requirements).match(vOf(pkg.version));
    }
    return true;
}

/** pick_best_registry_version: highest version matching the requirements (libraries are system "*"). */
function pickBest(versions: RegistryVersion[], spec: LibSpec): RegistryVersion | null {
    const req = spec.requirements ? new SimpleSpec(spec.requirements) : null;
    let best: RegistryVersion | null = null;
    let bestV: Version | null = null;
    for (const v of versions) {
        const sv = vOf(v.name);
        if (req && !req.match(sv)) continue;
        if (!v.files.some((f) => !f.system || f.system === "*" || (Array.isArray(f.system) && f.system.includes("*")))) continue;
        if (!bestV || sv.compare(bestV) > 0) {
            best = v;
            bestV = sv;
        }
    }
    return best;
}

const qualify = (k: string, vals: string[]) => [...new Set(vals)].map((v) => `${k}:"${v.replace(/"/g, "")}"`);

export async function resolveLibDeps(libDeps: string[], ctx: ResolveContext): Promise<ResolveResult> {
    const packages: InstalledPackage[] = [];
    const warnings: string[] = [];
    const history = new Map<string, InstalledPackage | null>();
    const envCompat = { platforms: [ctx.platform], frameworks: ctx.frameworks };

    const getInstalled = (spec: LibSpec) => {
        let best: InstalledPackage | null = null;
        for (const p of packages) {
            if (!satisfies(spec, { owner: p.owner, name: p.manifest?.name ?? p.name, version: p.version })) continue;
            if (!best || vOf(p.version).compare(vOf(best.version)) > 0) best = p;
        }
        return best;
    };

    const fromRegistry = async (spec: LibSpec, label: string, searchQualifiers: Record<string, string[]> | null): Promise<{ pkg: RegistryPackage; version: RegistryVersion }> => {
        if (spec.owner && spec.name && !searchQualifiers) {
            const pkg = await ctx.client.getPackage(spec.owner, spec.name);
            if (!pkg) throw new LibraryProblemError({ kind: "libNotFound", spec: label });
            const version = pickBest(pkg.versions ?? [pkg.version], spec);
            if (!version) throw new LibraryProblemError({ kind: "libVersion", spec: label, available: (pkg.versions ?? [pkg.version]).map((v) => v.name) });
            return { pkg, version };
        }
        const parts = [`type:"library"`, ...qualify("name", [spec.name!.toLowerCase()])];
        if (spec.owner) parts.push(...qualify("owner", [spec.owner.toLowerCase()]));
        for (const [k, vals] of Object.entries(searchQualifiers ?? {})) parts.push(...qualify(k.slice(0, -1), vals));
        const found = await ctx.client.search(parts.join(" "));
        if (!found.items.length) throw new LibraryProblemError({ kind: "libNotFound", spec: label });
        if (found.items.length > 1) warnings.push(`more than one package matches "${label}": ${found.items.map((i) => `${i.owner.username}/${i.name}@${i.version.name}`).join(", ")}`);
        const available: string[] = [];
        for (const item of found.items) {
            let version = pickBest([item.version], spec);
            let pkg: RegistryPackage | null = null;
            if (!version) {
                pkg = await ctx.client.getPackage(item.owner.username, item.name);
                version = pkg ? pickBest(pkg.versions ?? [], spec) : null;
                if (pkg) available.push(...(pkg.versions ?? []).map((v) => v.name));
            }
            if (version) {
                pkg ??= await ctx.client.getPackage(item.owner.username, item.name);
                if (!pkg) continue;
                return { pkg, version };
            }
        }
        throw new LibraryProblemError({ kind: "libVersion", spec: label, available: [...new Set(available)] });
    };

    const install = async (spec: LibSpec, label: string, direct: boolean, compat: Record<string, unknown> | null, depsCompat: Record<string, unknown> | null): Promise<InstalledPackage | null> => {
        const key = `${spec.owner ?? ""}/${spec.name ?? ""}@${spec.requirements ?? ""}`.toLowerCase();
        if (history.has(key)) return history.get(key)!;
        const have = getInstalled(spec);
        if (have) {
            history.set(key, have);
            if (direct) have.direct = true;
            await installDependencies(have, depsCompat);
            return have;
        }
        const sq: Record<string, string[]> = {};
        for (const k of ["platforms", "frameworks", "authors"]) {
            const v = compat?.[k];
            if (v) sq[k] = Array.isArray(v) ? (v as string[]) : String(v).split(",").map((x) => x.trim()).filter(Boolean);
        }
        const { pkg, version } = await fromRegistry(spec, label, Object.keys(sq).length ? sq : null);
        const file = version.files.find((f) => !f.system || f.system === "*" || (Array.isArray(f.system) && f.system.includes("*")))!;
        ctx.onDownload?.(pkg.name, file.size);
        const tgz = await ctx.client.tarball(file, ctx.onBytes);
        const { files, manifest } = await unpackPackage(tgz);
        const metaName = manifest?.name || pkg.name;
        const metaVersion = manifest?.version ? String(manifest.version) : version.name;
        // _install_tmp_pkg: same dir name, other version or owner → the older one is detached
        let dirName = safeDirName(metaName);
        const clash = packages.find((p) => p.dirName === dirName);
        if (clash && (clash.version !== metaVersion || !ciEq(clash.owner, pkg.owner.username))) {
            if (vOf(metaVersion).compare(vOf(clash.version)) > 0) clash.dirName = `${dirName}@${clash.version}`;
            else dirName = `${dirName}@${metaVersion}`;
        } else if (clash) packages.splice(packages.indexOf(clash), 1);
        const installed: InstalledPackage = { owner: pkg.owner.username, name: pkg.name, version: metaVersion, dirName, sha256: file.checksum.sha256, file, files, manifest, requestedBy: label, direct };
        packages.push(installed);
        history.set(key, installed);
        await installDependencies(installed, depsCompat);
        return installed;
    };

    const installDependencies = async (p: InstalledPackage, envCompatibility: Record<string, unknown> | null) => {
        for (const dep of p.manifest?.dependencies ?? []) {
            const depCompat: Record<string, unknown> = {};
            for (const k of ["owner", "name", "version", "platforms", "frameworks", "authors"] as const) if (dep[k] !== undefined) depCompat[k] = dep[k];
            if (envCompatibility && !isCompatible(depCompat, envCompatibility)) continue;
            const spec = depSpec(dep);
            if (!spec) continue;
            if (!spec.owner && ctx.builtinNames.includes(dep.name)) continue;
            const label = humanizeLibSpec(spec);
            try {
                await install(spec, label, false, depCompat, envCompatibility);
            } catch (e) {
                if (e instanceof LibraryProblemError && (e.problem.kind === "libNotFound" || e.problem.kind === "libVersion")) {
                    warnings.push(`could not install dependency "${label}" of ${p.name}`);
                    continue;
                }
                throw e;
            }
        }
    };

    // 1. pio pkg install for the env
    for (const raw of libDeps) {
        let spec: LibSpec;
        try {
            spec = parseLibSpec(raw);
        } catch (e) {
            throw new LibraryProblemError({ kind: "libUnsupported", spec: raw, reason: `invalid version requirement (${(e as Error).message})` });
        }
        if (spec.uri) throw new LibraryProblemError({ kind: "libUnsupported", spec: raw, reason: "Git and URL dependencies are not supported in the browser; use a registry library (owner/Name@version)" });
        if (spec.id !== undefined && !spec.name) throw new LibraryProblemError({ kind: "libUnsupported", spec: raw, reason: "numeric package ids are not supported; use owner/Name" });
        if (!spec.owner) continue;
        await install(spec, raw, true, null, envCompat);
    }
    // 2. ProjectAsLibBuilder.install_dependencies: specs found nowhere are searched for
    for (const raw of libDeps) {
        if (ctx.packLibraries.some((l) => l.name === raw)) continue;
        const spec = parseLibSpec(raw);
        if (spec.uri || !spec.name) continue;
        const inPack = ctx.packLibraries.some((l) => satisfies(spec, { owner: l.owner, name: l.scan?.pkgName ?? l.name, version: l.version }));
        if (inPack || getInstalled(spec)) {
            const p = getInstalled(spec);
            if (p) p.direct = true;
            continue;
        }
        await install(spec, raw, true, null, null);
    }
    return { packages, warnings };
}

export { RegistryUnreachableError };

/** A package tarball → its files relative to the package root, and its manifest. */
export async function unpackPackage(tgz: Uint8Array): Promise<{ files: Map<string, Uint8Array>; manifest: LibManifest | null }> {
    const entries = readTar(await gunzip(tgz));
    const root = packageRoot(entries.map((e) => e.path));
    const files = new Map<string, Uint8Array>();
    for (const e of entries) {
        if (root && !e.path.startsWith(`${root}/`)) continue;
        files.set(root ? e.path.slice(root.length + 1) : e.path, e.data);
    }
    let manifest: LibManifest | null = null;
    for (const n of LIBRARY_MANIFEST_NAMES) {
        const data = files.get(n);
        if (!data) continue;
        try {
            manifest = parseManifestBytes(n as LibManifest["type"], data);
        } catch {
            manifest = null;
        }
        break;
    }
    return { files, manifest };
}
