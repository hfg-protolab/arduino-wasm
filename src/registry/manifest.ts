/**
 * Library manifest normalisation, ported from PlatformIO 6.2's `LibraryJsonManifestParser`,
 * `LibraryPropertiesManifestParser` and `ModuleJsonManifestParser`
 * (platformio/package/manifest/parser.py), limited to the fields building and resolving need.
 *
 * - library.json: `keywords`/`platforms`/`frameworks` accept a list or a comma string and are
 *   lower-cased and de-duplicated, `headers` only de-duplicated; platform `espressif` means
 *   `espressif8266`. Dependencies come as `{name: version}` (with `owner/name` keys), a single
 *   legacy `{name, version, …}` object, a list of objects (an `owner/name` in `name` is split)
 *   or a list of plain names; `platforms`/`frameworks`/`authors` of a dependency become lists.
 * - library.properties: `key=value` lines split at the first `=`, `#` comments and empty values
 *   dropped; frameworks are always `["arduino"]`, `architectures` map to PlatformIO platforms
 *   (`*` → `["*"]`, unknown ones dropped), `includes` → headers, `depends` → dependencies with an
 *   optional `(version)` and frameworks `["arduino"]`.
 * - module.json (mbed): frameworks `["mbed"]`, platforms `["*"]`, dependency dict.
 *
 * Any failure (invalid JSON, wrong value types) is a `ManifestParseError`, as PlatformIO wraps
 * every exception of a parser into `ManifestParserError`.
 */
import { SimpleSpec, castVersion, type Version } from "./semver";

export interface LibDependency {
    owner?: string;
    name: string;
    version?: string;
    platforms?: string[];
    frameworks?: string[];
    authors?: string[];
}

export interface LibManifest {
    type: "library.json" | "library.properties" | "module.json";
    name?: string;
    version?: string;
    description?: string;
    frameworks?: string[];
    platforms?: string[];
    headers?: string[];
    keywords?: string[];
    dependencies?: LibDependency[];
    /** library.json "build" object as is (flags, unflags, srcFilter, srcDir, includeDir, libArchive, libLDFMode, libCompatMode, extraScript, builder) */
    build?: {
        flags?: string | string[];
        unflags?: string | string[];
        srcFilter?: string | string[];
        srcDir?: string;
        includeDir?: string;
        libArchive?: boolean;
        libLDFMode?: string;
        libCompatMode?: string;
        extraScript?: string;
        builder?: string;
    };
    /** library.properties raw keys you need: precompiled, ldflags, dot_a_linkage, includes, architectures, depends */
    properties?: Record<string, string>;
}

export class ManifestParseError extends Error {
    constructor(message: string) {
        super(`Could not parse manifest -> ${message}`);
        this.name = "ManifestParseError";
    }
}

/** PlatformIO's manifest file order for libraries: library.json, library.properties, module.json — the first that exists wins. */
export const LIBRARY_MANIFEST_NAMES: readonly string[] = ["library.json", "library.properties", "module.json"];

class Invalid extends Error {}

/** `BaseManifestParser.str_to_list`. */
function strToList(value: unknown, sep = ",", lowercase = false, unique = false): string[] {
    const list = typeof value === "string" ? value.split(sep) : value;
    if (!Array.isArray(list)) throw new Invalid(`expected a string or a list, got ${JSON.stringify(value)}`);
    const result: string[] = [];
    for (const raw of list) {
        if (typeof raw !== "string") throw new Invalid(`expected a string item, got ${JSON.stringify(raw)}`);
        let item = raw.trim();
        if (!item) continue;
        if (lowercase) item = item.toLowerCase();
        if (unique && result.includes(item)) continue;
        result.push(item);
    }
    return result;
}

/** `platformio.util.items_to_list`: lists as they are, strings split at "," and trimmed. */
function itemsToList(items: unknown): string[] {
    if (Array.isArray(items)) return items as string[];
    if (typeof items !== "string") throw new Invalid(`expected a string or a list, got ${JSON.stringify(items)}`);
    return items
        .split(",")
        .map((i) => i.trim())
        .filter(Boolean);
}

/** `platformio.util.items_in_list`: `*` on either side matches everything, else any common item. */
export function itemsInList(needle: string | string[] | undefined, haystack: string | string[] | undefined): boolean {
    const n = itemsToList(needle ?? []);
    const h = itemsToList(haystack ?? []);
    if (n.includes("*") || h.includes("*")) return true;
    return n.some((x) => h.includes(x));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

function toDependency(d: Record<string, unknown>): LibDependency {
    const name = str(d.name);
    if (name === undefined) throw new Invalid(`dependency without a name: ${JSON.stringify(d)}`);
    const dep: LibDependency = { name };
    const owner = str(d.owner);
    if (owner !== undefined) dep.owner = owner;
    const version = str(d.version);
    if (version !== undefined) dep.version = version;
    for (const k of ["platforms", "frameworks", "authors"] as const) {
        if (d[k] !== undefined && d[k] !== null) dep[k] = d[k] as string[];
    }
    return dep;
}

/** `LibraryJsonManifestParser._parse_dependencies`. */
function jsonDependencies(raw: unknown): LibDependency[] {
    if (isObject(raw) && "name" in raw) raw = [raw];
    if (isObject(raw)) {
        return Object.entries(raw).map(([name, version]) => {
            const slash = name.indexOf("/");
            const d: Record<string, unknown> = slash >= 0 ? { owner: name.slice(0, slash), name: name.slice(slash + 1), version } : { name, version };
            return toDependency(d);
        });
    }
    if (Array.isArray(raw)) {
        return raw.map((dependency) => {
            if (!isObject(dependency)) return toDependency({ name: dependency });
            const d = { ...dependency };
            for (const k of ["platforms", "frameworks", "authors"]) if (k in d) d[k] = itemsToList(d[k]);
            const name = d.name ?? "";
            if (typeof name !== "string") throw new Invalid(`invalid dependency name ${JSON.stringify(name)}`);
            if (!("owner" in d) && name.includes("/")) {
                const slash = name.indexOf("/");
                d.owner = name.slice(0, slash);
                d.name = name.slice(slash + 1);
            }
            return toDependency(d);
        });
    }
    throw new Invalid("Invalid dependencies format, should be list or dictionary");
}

function parseJson(text: string): Record<string, unknown> {
    const data: unknown = JSON.parse(text);
    if (!isObject(data)) throw new Invalid("manifest is not a JSON object");
    return data;
}

/** `normalize_repository` runs on every manifest and fails on a non-object `repository`. */
function checkRepository(data: Record<string, unknown>): void {
    const repo = data.repository;
    if (!truthy(repo)) return;
    if (!isObject(repo)) throw new Invalid(`'${typeof repo}' object has no attribute 'get'`);
    if (truthy(repo.url) && typeof repo.url !== "string") throw new Invalid("invalid repository url");
}

function libraryJson(text: string): LibManifest {
    const data = parseJson(text);
    checkRepository(data);
    const m: LibManifest = { type: "library.json" };
    if (str(data.name) !== undefined) m.name = str(data.name);
    if (str(data.version) !== undefined) m.version = str(data.version);
    if (typeof data.description === "string") m.description = data.description;
    for (const k of ["keywords", "platforms", "frameworks"] as const) if (k in data) m[k] = strToList(data[k], ",", true, true);
    if ("headers" in data) m.headers = strToList(data.headers, ",", false, true);
    if (m.platforms) {
        const i = m.platforms.indexOf("espressif");
        if (i >= 0) m.platforms[i] = "espressif8266";
        if (!m.platforms.length) delete m.platforms;
    }
    if ("dependencies" in data) m.dependencies = jsonDependencies(data.dependencies);
    if (isObject(data.build)) m.build = data.build as LibManifest["build"];
    return m;
}

function moduleJson(text: string): LibManifest {
    const data = parseJson(text);
    checkRepository(data);
    const m: LibManifest = { type: "module.json", frameworks: ["mbed"], platforms: ["*"] };
    if (str(data.name) !== undefined) m.name = str(data.name);
    if (str(data.version) !== undefined) m.version = str(data.version);
    if (typeof data.description === "string") m.description = data.description;
    if ("dependencies" in data) {
        if (!isObject(data.dependencies)) throw new Invalid("Invalid dependencies format, should be a dictionary");
        m.dependencies = Object.entries(data.dependencies).map(([name, version]) => ({ ...toDependency({ name, version }), frameworks: ["mbed"] }));
    }
    if ("keywords" in data) m.keywords = strToList(data.keywords, ",", true, true);
    return m;
}

/** Python's `str.splitlines` separators. */
const SPLITLINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

const ARCH_TO_PLATFORM: Record<string, string> = {
    avr: "atmelavr",
    sam: "atmelsam",
    samd: "atmelsam",
    esp8266: "espressif8266",
    esp32: "espressif32",
    arc32: "intel_arc32",
    stm32: "ststm32",
    nrf52: "nordicnrf52",
    rp2040: "raspberrypi",
};

function libraryProperties(text: string): LibManifest {
    const props: Record<string, string> = {};
    for (let line of text.split(SPLITLINES)) {
        line = line.trim();
        if (!line || !line.includes("=") || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        const value = line.slice(eq + 1).trim();
        if (!value) continue;
        props[line.slice(0, eq).trim()] = value;
    }
    const m: LibManifest = { type: "library.properties", frameworks: ["arduino"], properties: props };
    if (props.name !== undefined) m.name = props.name;
    if (props.version !== undefined) m.version = props.version;

    // _parse_description
    const lines: string[] = [];
    for (const k of ["sentence", "paragraph"]) if (props[k] !== undefined && !lines.includes(props[k]!)) lines.push(props[k]!);
    if (lines.length === 2) {
        if (!lines[0]!.endsWith(".")) lines[0] += ".";
        if (lines[0]!.length + lines[1]!.length >= 1000) lines.pop();
    }
    m.description = lines.join(" ");

    // _parse_platforms
    let platforms: string[] = [];
    for (let arch of (props.architectures ?? "").split(",")) {
        if (arch.includes("particle-")) throw new Invalid("Particle is not supported yet");
        arch = arch.trim();
        if (!arch) continue;
        if (arch === "*") {
            platforms = ["*"];
            break;
        }
        if (Object.hasOwn(ARCH_TO_PLATFORM, arch)) platforms.push(ARCH_TO_PLATFORM[arch]!);
    }
    platforms = strToList(platforms, ",", true, true);
    if (platforms.length) m.platforms = platforms;

    const keywords = strToList((props.category ?? "").split(/[\s/]+/), ",", true, true);
    if (keywords.length) m.keywords = keywords;
    if (props.includes !== undefined) m.headers = strToList(props.includes, ",", false, true);

    if (props.depends !== undefined) {
        m.dependencies = [];
        for (let item of props.depends.split(",")) {
            item = item.trim();
            if (!item) continue;
            if (item.endsWith(")") && item.includes("(")) {
                const parts = item.split("(");
                if (parts.length !== 2) throw new Invalid(`too many values to unpack in dependency '${item}'`);
                m.dependencies.push({ name: parts[0]!.trim(), version: parts[1]!.slice(0, -1).trim(), frameworks: ["arduino"] });
            } else {
                m.dependencies.push({ name: item, frameworks: ["arduino"] });
            }
        }
    }
    return m;
}

export function parseManifest(type: LibManifest["type"], text: string): LibManifest {
    try {
        if (type === "library.json") return libraryJson(text);
        if (type === "library.properties") return libraryProperties(text);
        if (type === "module.json") return moduleJson(text);
    } catch (e) {
        throw new ManifestParseError(e instanceof Error ? e.message : String(e));
    }
    throw new ManifestParseError(`Unknown manifest file type ${type}`);
}

/** `read_manifest_contents`: UTF-8 first, latin-1 when the bytes are not valid UTF-8. */
export function parseManifestBytes(type: LibManifest["type"], bytes: Uint8Array): LibManifest {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    }
    return parseManifest(type, text);
}

const KNOWN_QUALIFIERS = ["owner", "name", "version", "platforms", "frameworks", "authors"] as const;

/** Python truthiness for qualifier values: None, "", [], {}, 0 and false are skipped. */
function truthy(v: unknown): boolean {
    if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (isObject(v)) return Object.keys(v).length > 0;
    return true;
}

/** `PackageCompatibility._compare_versions`: equal strings, or the version matches the spec. */
function compareVersions(current: unknown, other: unknown): boolean {
    if (current === other) return true;
    try {
        const version: Version = castVersion(String(other));
        return new SimpleSpec(String(current)).match(version);
    } catch {
        return false;
    }
}

/**
 * `PackageCompatibility(**a).is_compatible(PackageCompatibility(**b))`: every qualifier set on
 * both sides must agree — lists by `items_in_list`, `version` as a spec of `a` matching the
 * version of `b`, everything else by plain equality.
 */
export function isCompatible(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    for (const key of KNOWN_QUALIFIERS) {
        const current = a[key];
        const other = b[key];
        if (!truthy(current) || !truthy(other)) continue;
        if (Array.isArray(current) || Array.isArray(other)) {
            if (!itemsInList(current as string | string[], other as string | string[])) return false;
            continue;
        }
        if (key === "version") {
            if (!compareVersions(current, other)) return false;
            continue;
        }
        if (current !== other) return false;
    }
    return true;
}
