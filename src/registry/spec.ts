/**
 * Port of PlatformIO 6.2's `PackageSpec` (platformio/package/meta.py): how one `lib_deps` entry
 * or one manifest dependency is split into owner / id / name / requirements / uri.
 *
 * The raw string runs through the parsers in PlatformIO's order, each consuming its part:
 * local file → `@requirements` → `customName=` → `id=`/numeric id → `owner/name` → URI. What is
 * left over is the name; a URI without a custom name derives its name from the URL.
 *
 * In the browser no local path exists, so `_parse_local_file` never turns a bare path into a
 * `file://` URI: only explicit `file://` / `symlink://` prefixes count.
 */
import { SimpleSpec } from "./semver";

export interface LibSpec {
    raw: string;
    owner?: string;
    id?: number;
    name?: string;
    /** The requirements expression as written (a valid `SimpleSpec`). */
    requirements?: string;
    uri?: string;
    /** `Name=…` form; note that PlatformIO only keeps the custom name for URIs. */
    customName?: boolean;
}

interface UrlParts {
    scheme: string;
    netloc: string;
    path: string;
}

const SCHEME_CHARS = /^[a-zA-Z0-9+.-]+$/;
const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtsps", "rtspu", "sip", "sips", "mms", "sftp", "tel"]);

/** `urllib.parse.urlparse`, reduced to scheme / netloc / path. */
function urlparse(url: string): UrlParts {
    let scheme = "";
    let netloc = "";
    const colon = url.indexOf(":");
    if (colon > 0 && /^[a-zA-Z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
        scheme = url.slice(0, colon).toLowerCase();
        url = url.slice(colon + 1);
    }
    if (url.startsWith("//")) {
        let end = url.length;
        for (const c of "/?#") {
            const i = url.indexOf(c, 2);
            if (i >= 0) end = Math.min(end, i);
        }
        netloc = url.slice(2, end);
        url = url.slice(end);
    }
    const hash = url.indexOf("#");
    if (hash >= 0) url = url.slice(0, hash);
    const q = url.indexOf("?");
    if (q >= 0) url = url.slice(0, q);
    if (USES_PARAMS.has(scheme) && url.includes(";")) {
        const slash = url.lastIndexOf("/");
        const i = slash >= 0 ? url.indexOf(";", slash) : url.indexOf(";");
        if (i >= 0) url = url.slice(0, i);
    }
    return { scheme, netloc, path: url };
}

function isDigits(s: string): boolean {
    return /^[0-9]+$/.test(s);
}

interface MutableSpec {
    raw?: string;
    owner?: string;
    id?: number;
    name?: string;
    requirements?: string;
    uri?: string;
    customName: boolean;
}

/** The `requirements` setter: empty clears, anything else must be a valid `SimpleSpec`. */
function setRequirements(spec: MutableSpec, value: string): void {
    if (!value) {
        spec.requirements = undefined;
        return;
    }
    new SimpleSpec(value); // throws like SemanticVersionError
    spec.requirements = value;
}

function parseRequirements(spec: MutableSpec, raw: string): string {
    if (!raw.includes("@") || raw.startsWith("file://") || raw.startsWith("symlink://")) return raw;
    const at = raw.lastIndexOf("@");
    const req = raw.slice(at + 1);
    if (req.includes(":") || req.includes("/")) return raw;
    setRequirements(spec, req.trim());
    return raw.slice(0, at).trim();
}

function parseCustomName(spec: MutableSpec, raw: string): string {
    if (!raw.includes("=") || raw.startsWith("id=")) return raw;
    const eq = raw.indexOf("=");
    if (raw.slice(0, eq).includes("/")) return raw;
    spec.name = raw.slice(0, eq).trim();
    spec.customName = true;
    return raw.slice(eq + 1).trim();
}

function parseId(spec: MutableSpec, raw: string): string | null {
    if (isDigits(raw)) {
        spec.id = Number(raw);
        return null;
    }
    if (raw.startsWith("id=")) return parseId(spec, raw.slice(3));
    return raw;
}

function parseOwner(spec: MutableSpec, raw: string): string | null {
    if ((raw.match(/\//g) ?? []).length !== 1 || raw.includes("@")) return raw;
    const slash = raw.indexOf("/");
    spec.owner = raw.slice(0, slash).trim();
    spec.name = raw.slice(slash + 1).trim();
    return null;
}

/** `_parse_uri`: GitHub/GitLab/Bitbucket and `.git` URLs get `git+`, mbed URLs `hg+`. */
function parseUri(spec: MutableSpec, raw: string): string | null {
    if (!["@", ":", "/"].some((c) => raw.includes(c))) return raw;
    spec.uri = raw.trim();
    const parts = urlparse(spec.uri);
    // PlatformIO compares the scheme with "symlink://", which never matches; kept as is.
    if (parts.scheme === "file" || parts.scheme.includes("+") || spec.uri.startsWith("git+")) return null;
    const git =
        parts.path.endsWith(".git") ||
        (["github.com", "gitlab.com", "bitbucket.com"].includes(parts.netloc) &&
            ![".zip", ".tar.gz", ".tar.xz"].some((e) => parts.path.endsWith(e)));
    const hg = ["mbed.com", "os.mbed.com", "developer.mbed.org"].includes(parts.netloc);
    if (git) spec.uri = "git+" + spec.uri;
    else if (hg) spec.uri = "hg+" + spec.uri;
    return null;
}

/** `_parse_name_from_uri`: GitHub repo name, else the basename up to its first ".". */
function nameFromUri(uri: string): string {
    if (uri.endsWith("/")) uri = uri.slice(0, -1);
    const stops = ["#", "?"];
    if (uri.startsWith("file://") || uri.startsWith("symlink://")) stops.push("@");
    for (const c of stops) {
        const i = uri.indexOf(c);
        if (i >= 0) uri = uri.slice(0, i);
    }
    const parts = urlparse(uri);
    if (parts.netloc === "github.com" && (parts.path.match(/\//g) ?? []).length > 2) return parts.path.split("/")[2]!;
    const name = uri.slice(uri.lastIndexOf("/") + 1);
    return name.includes(".") ? name.split(".")[0]!.trim() : name;
}

function parseInto(spec: MutableSpec, rawIn: string): void {
    let raw: string | null = rawIn.trim();
    const parsers: Array<(s: MutableSpec, r: string) => string | null> = [
        (_s, r) => r, // _parse_local_file: no filesystem in the browser
        parseRequirements,
        parseCustomName,
        parseId,
        parseOwner,
        parseUri,
    ];
    for (const p of parsers) {
        if (raw === null) break;
        raw = p(spec, raw);
    }
    if (!spec.name && spec.uri) spec.name = nameFromUri(spec.uri);
    else if (raw) spec.name = raw;
}

/** `PackageSpec(raw=…, owner=…, name=…, requirements=…)`. */
function makeSpec(init: { raw?: string; owner?: string; name?: string; requirements?: string }): MutableSpec {
    const spec: MutableSpec = { owner: init.owner, name: init.name, raw: init.raw, customName: false };
    if (init.requirements) {
        try {
            setRequirements(spec, init.requirements);
        } catch (e) {
            // A "version" that is no spec (e.g. a Git URL) turns into `name=version`.
            if (!spec.name || spec.uri || spec.raw) throw e;
            spec.raw = `${spec.name}=${init.requirements}`;
        }
    }
    if (spec.raw !== undefined) parseInto(spec, spec.raw);
    return spec;
}

function toLibSpec(s: MutableSpec, raw: string): LibSpec {
    const out: LibSpec = { raw };
    if (s.owner !== undefined) out.owner = s.owner;
    if (s.id !== undefined) out.id = s.id;
    if (s.name !== undefined) out.name = s.name;
    if (s.requirements !== undefined) out.requirements = s.requirements;
    if (s.uri !== undefined) out.uri = s.uri;
    if (s.customName) out.customName = true;
    return out;
}

/** Parses one `lib_deps` entry; throws when its `@requirements` is not a valid `SimpleSpec`. */
export function parseLibSpec(raw: string): LibSpec {
    return toLibSpec(makeSpec({ raw }), raw);
}

/** `PackageSpec.humanize`: `owner/name @ ^1.2.3`, the URI, or `id:123`. */
export function humanizeLibSpec(s: LibSpec): string {
    let result = "";
    if (s.uri) result = s.uri;
    else if (s.name) result = (s.owner ? s.owner + "/" : "") + s.name;
    else if (s.id) result = `id:${s.id}`;
    if (s.requirements) result += " @ " + s.requirements;
    return result;
}

/** `PackageSpec(owner=, name=, requirements=version).as_dependency()`: `owner/Name@^1.2.3`. */
export function serializeLibDep(dep: { owner?: string; name: string; version?: string }): string {
    const s = makeSpec({ owner: dep.owner, name: dep.name, requirements: dep.version });
    if (s.uri) return s.raw || s.uri;
    let result = "";
    if (s.name) result = s.owner ? `${s.owner}/${s.name}` : s.name;
    else if (s.id) result = String(s.id);
    if (!result) throw new Error("serializeLibDep: dependency without a name");
    if (s.requirements) result = `${result}@${s.requirements}`;
    return result;
}
