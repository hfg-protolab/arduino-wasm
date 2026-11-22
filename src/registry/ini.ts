/**
 * `platformio.ini` reader, ported from PlatformIO 6.2's `ProjectConfig` (platformio/project/
 * config.py + options.py) on top of Python's `configparser.ConfigParser(inline_comment_prefixes=
 * ("#", ";"))`:
 *
 * - Full-line comments start with `#` or `;` (also when indented); inline comments need
 *   whitespace (or the line start) before the `#`/`;`. Options are `key = value` or
 *   `key: value`, keys are lower-cased, a line indented deeper than its option line continues
 *   the value, blank lines inside a value are kept (trailing ones trimmed). `[DEFAULT]` options
 *   are visible in every section. Duplicate sections/options are errors (strict mode).
 * - configparser's `%` interpolation applies: `%%` is a literal `%`, `%(key)s` refers to the
 *   same section, any other `%` is an error.
 * - An `[env:NAME]` walks itself, then its `extends` (last one first), then `[env]`; the first
 *   section that has an option (or one of its old names, e.g. `lib_use` for `lib_deps`) wins.
 * - `${section.option}` is expanded through the same lookup (`${this.option}`, `${this.__env__}`,
 *   `${sysenv.X}` → "" in the browser); `${NAME}` without a section is left for SCons.
 * - Multi-value options (`lib_deps`, `build_flags`, `framework`, …) are split by newlines when
 *   the value has any, otherwise by `", "` (comma + space); items starting with `;`/`#` are
 *   dropped and ` ;…` tails are cut (`parse_multi_values`).
 */

export interface PlatformioIni {
    sections: Array<{ name: string; options: Array<{ key: string; value: string }> }>;
    /** the effective environment: [env] merged with the FIRST [env:*] (env options override [env]); `${…}` interpolated */
    env: {
        name: string | null;
        platform?: string;
        board?: string;
        /** The raw `framework` value; PlatformIO treats it as a list, see `frameworks`. */
        framework?: string;
        frameworks: string[];
        libDeps: string[];
        buildFlags: string[];
        libIgnore: string[];
        libLdfMode?: string;
        libCompatMode?: string;
        libArchive?: string;
        /** keys of the effective env this compiler does not support */
        unsupported: string[];
    };
    /** syntax problems, with 1-based line numbers */
    errors: Array<{ line: number; message: string }>;
}

// --- option metadata (options.py, env + platformio scopes) -----------------------------------

type OptionType = { choices: string[] } | "bool" | "int" | "str";

interface OptionMeta {
    multiple?: boolean;
    oldnames?: string[];
    default?: string | string[] | boolean | number;
    type?: OptionType;
}

const ENV_OPTIONS: Record<string, OptionMeta> = {
    platform: {},
    platform_packages: { multiple: true },
    board: {},
    framework: { multiple: true },
    "board_build.mcu": { oldnames: ["board_mcu"] },
    "board_build.f_cpu": { oldnames: ["board_f_cpu"] },
    "board_build.f_flash": { oldnames: ["board_f_flash"] },
    "board_build.flash_mode": { oldnames: ["board_flash_mode"] },
    build_type: { default: "release", type: { choices: ["release", "test", "debug"] } },
    build_flags: { multiple: true },
    build_src_flags: { multiple: true, oldnames: ["src_build_flags"] },
    build_unflags: { multiple: true },
    build_src_filter: { multiple: true, oldnames: ["src_filter"], default: "+<*> -<.git/> -<.svn/>" },
    targets: { multiple: true },
    upload_port: {},
    upload_protocol: {},
    upload_speed: { type: "int" },
    upload_flags: { multiple: true },
    upload_resetmethod: {},
    upload_command: {},
    monitor_port: {},
    monitor_speed: { oldnames: ["monitor_baud"], default: 9600, type: "int" },
    monitor_parity: { default: "N", type: { choices: ["N", "E", "O", "S", "M"] } },
    monitor_filters: { multiple: true },
    monitor_rts: { type: "int" },
    monitor_dtr: { type: "int" },
    monitor_eol: { default: "CRLF", type: { choices: ["CR", "LF", "CRLF"] } },
    monitor_raw: { default: false, type: "bool" },
    monitor_echo: { default: false, type: "bool" },
    monitor_encoding: { default: "UTF-8" },
    lib_deps: { multiple: true, oldnames: ["lib_use", "lib_force", "lib_install"] },
    lib_ignore: { multiple: true },
    lib_extra_dirs: { multiple: true },
    lib_ldf_mode: { default: "chain", type: { choices: ["off", "chain", "deep", "chain+", "deep+"] } },
    lib_compat_mode: { default: "soft", type: { choices: ["off", "soft", "strict"] } },
    lib_archive: { default: true, type: "bool" },
    check_tool: { multiple: true, default: ["cppcheck"], type: { choices: ["cppcheck", "clangtidy"] } },
    check_src_filters: { multiple: true, oldnames: ["check_patterns"] },
    check_flags: { multiple: true },
    check_severity: { multiple: true, default: ["low", "medium", "high"], type: { choices: ["low", "medium", "high"] } },
    check_skip_packages: { default: false, type: "bool" },
    test_framework: { default: "unity", type: { choices: ["doctest", "googletest", "unity", "custom"] } },
    test_filter: { multiple: true },
    test_ignore: { multiple: true },
    test_port: {},
    test_speed: { default: 115200, type: "int" },
    test_build_src: { oldnames: ["test_build_project_src"], default: false, type: "bool" },
    test_testing_command: { multiple: true },
    debug_tool: {},
    debug_build_flags: { multiple: true, default: ["-Og", "-g2", "-ggdb2"] },
    debug_init_break: { default: "tbreak main" },
    debug_init_cmds: { multiple: true },
    debug_extra_cmds: { multiple: true },
    debug_load_cmds: { multiple: true, oldnames: ["debug_load_cmd"], default: ["load"] },
    debug_load_mode: { default: "always", type: { choices: ["always", "modified", "manual"] } },
    debug_server: { multiple: true },
    debug_port: {},
    debug_speed: {},
    debug_svd_path: {},
    debug_server_ready_pattern: {},
    debug_test: {},
    extends: { multiple: true },
    extra_scripts: { multiple: true, oldnames: ["extra_script"] },
};

/** Directory defaults depend on the file system and are left out. */
const PLATFORMIO_OPTIONS: Record<string, OptionMeta> = {
    name: {},
    description: {},
    default_envs: { multiple: true, oldnames: ["env_default"] },
    extra_configs: { multiple: true },
    core_dir: { oldnames: ["home_dir"] },
    ...Object.fromEntries(
        ["globallib", "platforms", "packages", "cache", "build_cache", "workspace", "build", "libdeps", "include", "src", "lib", "data", "test", "boards", "monitor", "shared"].map(
            (n) => [`${n}_dir`, {}],
        ),
    ),
};

/** Options the compiler honours (plus everything that only matters to upload/monitor/test/debug/check). */
const SUPPORTED = new Set(["platform", "board", "framework", "lib_deps", "build_flags", "lib_ldf_mode", "lib_compat_mode", "lib_ignore", "lib_archive", "extends"]);
const SUPPORTED_PREFIXES = ["monitor_", "upload_", "test_", "debug_", "check_", "custom_"];

// --- configparser ---------------------------------------------------------------------------

interface RawOption {
    key: string;
    parts: string[];
    line: number;
    /** last line holding a part of the value (blank/comment lines after it excluded) */
    lastLine: number;
}

interface RawSection {
    name: string;
    line: number;
    options: Map<string, RawOption>;
}

interface Parsed {
    sections: Map<string, RawSection>;
    defaults: RawSection;
    errors: Array<{ line: number; message: string }>;
}

const DEFAULT_SECTION = "DEFAULT";

/** configparser's inline comment search: per round the next `#` and `;`; first round with a hit wins. */
function inlineCommentStart(line: string): number | null {
    let start = Infinity;
    let prefixes = new Map<string, number>([["#", -1], [";", -1]]);
    while (start === Infinity && prefixes.size) {
        const next = new Map<string, number>();
        for (const [prefix, from] of prefixes) {
            const index = line.indexOf(prefix, from + 1);
            if (index === -1) continue;
            next.set(prefix, index);
            if (index === 0 || /\s/.test(line[index - 1]!)) start = Math.min(start, index);
        }
        prefixes = next;
    }
    return start === Infinity ? null : start;
}

function splitLines(text: string): string[] {
    return text.split(/\r\n|\r|\n/);
}

/** `RawConfigParser._read` (strict, empty lines in values, `=`/`:` delimiters). */
function readConfig(text: string): Parsed {
    if (text.startsWith("\uFEFF")) text = text.slice(1);
    const sections = new Map<string, RawSection>();
    const defaults: RawSection = { name: DEFAULT_SECTION, line: 0, options: new Map() };
    const errors: Parsed["errors"] = [];
    const added = new Set<string>();
    let cursect: RawSection | null = null;
    let opt: RawOption | null = null;
    let indentLevel = 0;
    let missingHeaderReported = false;

    splitLines(text).forEach((line, i) => {
        const lineno = i + 1;
        let commentStart = inlineCommentStart(line);
        const stripped = line.trim();
        if (stripped.startsWith("#") || stripped.startsWith(";")) commentStart = 0;
        const value = (commentStart === null ? line : line.slice(0, commentStart)).trim();
        if (!value) {
            if (commentStart === null && cursect && opt) opt.parts.push("");
            return;
        }
        const firstNonSpace = line.search(/\S/);
        const curIndent = firstNonSpace < 0 ? 0 : firstNonSpace;
        if (cursect && opt && curIndent > indentLevel) {
            opt.parts.push(value);
            opt.lastLine = lineno;
            return;
        }
        indentLevel = curIndent;
        const sect = /^\[(.+)\]/.exec(value);
        if (sect) {
            const name = sect[1]!;
            if (name === DEFAULT_SECTION) cursect = defaults;
            else if (sections.has(name)) {
                errors.push({ line: lineno, message: `section '${name}' already exists` });
                cursect = sections.get(name)!;
            } else {
                cursect = { name, line: lineno, options: new Map() };
                sections.set(name, cursect);
            }
            opt = null;
            return;
        }
        if (!cursect) {
            if (!missingHeaderReported) errors.push({ line: lineno, message: "File contains no section headers." });
            missingHeaderReported = true;
            return;
        }
        const m = /^(.*?)\s*(=|:)\s*(.*)$/.exec(value);
        if (!m || !m[1]) {
            errors.push({ line: lineno, message: `Parsing error: ${line}` });
            opt = null;
            return;
        }
        const key = m[1].trimEnd().toLowerCase();
        const id = `${cursect.name}\u0000${key}`;
        if (cursect !== defaults && added.has(id)) {
            errors.push({ line: lineno, message: `option '${key}' in section '${cursect.name}' already exists` });
        }
        added.add(id);
        opt = { key, parts: [m[3]!.trim()], line: lineno, lastLine: lineno };
        cursect.options.delete(key);
        cursect.options.set(key, opt);
    });
    return { sections, defaults, errors };
}

function rawValue(o: RawOption): string {
    return o.parts.join("\n").trimEnd();
}

/** `ConfigParser.options(section)`: own keys, then `[DEFAULT]` keys. */
function sectionOptions(p: Parsed, section: string): RawOption[] {
    const s = p.sections.get(section);
    if (!s) return [];
    const out = [...s.options.values()];
    for (const [k, o] of p.defaults.options) if (!s.options.has(k)) out.push(o);
    return out;
}

function lookupRaw(p: Parsed, section: string, key: string): RawOption | undefined {
    if (section === DEFAULT_SECTION) return p.defaults.options.get(key);
    return p.sections.get(section)?.options.get(key) ?? p.defaults.options.get(key);
}

class ConfigError extends Error {
    constructor(
        message: string,
        readonly line: number,
    ) {
        super(message);
    }
}

/** `ConfigParser.get` with `BasicInterpolation` (`%%`, `%(key)s`). */
function parserGet(p: Parsed, section: string, key: string): string {
    if (section !== DEFAULT_SECTION && !p.sections.has(section)) throw new ConfigError(`No section: '${section}'`, 0);
    const o = lookupRaw(p, section, key);
    if (!o) throw new ConfigError(`No option '${key}' in section: '${section}'`, 0);
    const accum: string[] = [];
    const some = (rest: string, depth: number): void => {
        if (depth > 10) throw new ConfigError(`Recursion limit exceeded in value substitution: option '${key}' in section '${section}'`, o.line);
        while (rest) {
            const at = rest.indexOf("%");
            if (at < 0) {
                accum.push(rest);
                return;
            }
            if (at > 0) {
                accum.push(rest.slice(0, at));
                rest = rest.slice(at);
            }
            const c = rest.slice(1, 2);
            if (c === "%") {
                accum.push("%");
                rest = rest.slice(2);
            } else if (c === "(") {
                const m = /^%\(([^)]+)\)s/.exec(rest);
                if (!m) throw new ConfigError(`bad interpolation variable reference '${rest}'`, o.line);
                rest = rest.slice(m[0].length);
                const ref = lookupRaw(p, section, m[1]!.toLowerCase());
                if (!ref) throw new ConfigError(`Bad value substitution: option '${key}' in section '${section}' contains an interpolation key '${m[1]!.toLowerCase()}' which is not a valid option name`, o.line);
                const v = rawValue(ref);
                if (v.includes("%")) some(v, depth + 1);
                else accum.push(v);
            } else {
                throw new ConfigError(`'%' must be followed by '%' or '(', found: '${rest}'`, o.line);
            }
        }
    };
    some(rawValue(o), 1);
    return accum.join("");
}

// --- ProjectConfig ---------------------------------------------------------------------------

/** `ProjectConfigBase.parse_multi_values`. */
export function parseMultiValues(items: string | string[] | null | undefined): string[] {
    if (!items || !items.length) return [];
    const list = typeof items === "string" ? items.split(items.includes("\n") ? "\n" : ", ") : items;
    const result: string[] = [];
    for (let item of list) {
        item = item.trim();
        if (!item || item.startsWith(";") || item.startsWith("#")) continue;
        if (item.includes(";")) item = item.replace(/\s+;.*$/, "").trim();
        result.push(item);
    }
    return result;
}

function sectionScope(section: string): string {
    const i = section.indexOf(":");
    return i >= 0 ? section.slice(0, i) : section;
}

type Value = string | string[] | boolean | number | null;

class ProjectConfig {
    readonly errors: Array<{ line: number; message: string }> = [];
    private readonly stack: string[] = [];

    constructor(readonly p: Parsed) {}

    /** `walk_options`: (section, option) in lookup order; `extends` cycles are cut off. */
    *walk(root: string): Generator<{ section: string; opt: RawOption }> {
        const queue = root.startsWith("env:") ? ["env", root] : [root];
        let steps = 0;
        while (queue.length) {
            const section = queue.pop()!;
            if (++steps > 100) {
                this.error(`Infinite \`extends\` chain detected for [${root}]`, 0);
                return;
            }
            if (!this.p.sections.has(section)) continue;
            for (const opt of sectionOptions(this.p, section)) yield { section, opt };
            if (lookupRaw(this.p, section, "extends")) queue.push(...parseMultiValues(this.safeParserGet(section, "extends") ?? ""));
        }
    }

    options(root: string): string[] {
        const result: string[] = [];
        for (const { opt } of this.walk(root)) if (!result.includes(opt.key)) result.push(opt.key);
        return result;
    }

    meta(section: string, option: string): (OptionMeta & { name: string }) | undefined {
        const scope = sectionScope(section);
        const table = scope === "env" ? ENV_OPTIONS : scope === "platformio" ? PLATFORMIO_OPTIONS : undefined;
        if (!table) return undefined;
        if (Object.hasOwn(table, option)) return { ...table[option]!, name: option };
        for (const [name, m] of Object.entries(table)) if (m.oldnames?.includes(option)) return { ...m, name };
        return undefined;
    }

    /** The defining option for `option` as seen from `section` (`_traverse_for_value`). */
    find(section: string, option: string): { section: string; opt: RawOption } | undefined {
        const meta = this.meta(section, option);
        for (const hit of this.walk(section)) {
            const k = hit.opt.key;
            if (k === option || (meta && (meta.name === k || meta.oldnames?.includes(k)))) return hit;
        }
        return undefined;
    }

    /** `ProjectConfig.get`: lookup, interpolation, multi-value split and type check. */
    get(section: string, option: string): Value {
        const id = `${section}.${option}`;
        if (this.stack.includes(id)) throw new ConfigError(`Infinite recursion has been detected for \`${option}\` option in the \`${section}\` section`, 0);
        this.stack.push(id);
        try {
            const meta = this.meta(section, option);
            const hit = this.find(section, option);
            const line = hit?.opt.line ?? 0;
            let value: Value;
            if (hit) value = parserGet(this.p, hit.section, hit.opt.key);
            else if (meta) value = meta.default ?? null;
            else value = parserGet(this.p, section, option);
            if (typeof value === "string") value = this.expand(section, option, value, line);
            if (!meta) return value;
            if (meta.multiple) value = parseMultiValues(value as string | string[] | null);
            return this.cast(value, meta, option, section, line);
        } finally {
            this.stack.pop();
        }
    }

    private cast(value: Value, meta: OptionMeta, option: string, section: string, line: number): Value {
        const type = meta.type;
        if (!type || type === "str" || value === null) return value;
        const one = (v: string | boolean | number): string | boolean | number => {
            if (typeof v !== "string") return v;
            if (type === "bool") {
                const n = v.trim().toLowerCase();
                if (["1", "true", "t", "yes", "y", "on"].includes(n)) return true;
                if (["0", "false", "f", "no", "n", "off"].includes(n)) return false;
                throw new ConfigError(`'${v}' is not a valid boolean. for \`${option}\` option in the \`${section}\` section`, line);
            }
            if (type === "int") {
                if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(v)) throw new ConfigError(`'${v}' is not a valid integer. for \`${option}\` option in the \`${section}\` section`, line);
                return Number(v.replaceAll("_", ""));
            }
            if (!type.choices.includes(v)) {
                throw new ConfigError(`'${v}' is not one of ${type.choices.map((c) => `'${c}'`).join(", ")}. for \`${option}\` option in the \`${section}\` section`, line);
            }
            return v;
        };
        if (Array.isArray(value)) return value.map((v) => String(one(v)));
        return one(value);
    }

    /** `_expand_interpolations` + `_re_interpolation_handler`. */
    private expand(section: string, option: string, value: string, line: number): string {
        if (!value.includes("$")) return value;
        // legacy `$PROJECT_HASH`
        let x: number;
        while ((x = value.indexOf("$PROJECT_HASH")) >= 0 && value[x - 1] !== "$") {
            value = `${value.slice(0, x)}\${PROJECT_HASH}${value.slice(x + "$PROJECT_HASH".length)}`;
        }
        if (!value.includes("${") || !value.includes("}")) return value;
        return value.replace(/\$\{(?:([^.}()]+)\.)?([^}]+)\}/g, (_whole, sect: string | undefined, opt: string) => {
            if (sect === undefined) return `\${${opt}}`; // built-ins (PROJECT_DIR, …) and SCons variables
            if (sect === "sysenv") return "";
            if (sect === "this") {
                sect = section;
                if (opt === "__env__") {
                    if (!section.startsWith("env:")) {
                        throw new ConfigError(`\`\${this.__env__}\` is called from the \`${section}\` section that is not valid PlatformIO environment. Please check \`${option}\` option in the \`${section}\` section`, line);
                    }
                    return section.slice(4);
                }
            }
            let v: Value;
            try {
                v = this.get(sect, opt);
            } catch (e) {
                if (e instanceof ConfigError && !e.line) throw new ConfigError(e.message, line);
                throw e;
            }
            if (Array.isArray(v)) return v.join("\n");
            return v === null ? "None" : typeof v === "boolean" ? (v ? "True" : "False") : String(v);
        });
    }

    safeParserGet(section: string, key: string): string | undefined {
        try {
            return parserGet(this.p, section, key);
        } catch (e) {
            if (e instanceof ConfigError) this.error(e.message, e.line);
            else throw e;
            return undefined;
        }
    }

    /** `get` that records errors instead of throwing; `undefined` when the option is not set. */
    tryGet(section: string, option: string): Value | undefined {
        if (!this.find(section, option)) return undefined;
        try {
            return this.get(section, option);
        } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            this.error(e.message, e.line || (this.find(section, option)?.opt.line ?? 0));
            return undefined;
        }
    }

    error(message: string, line: number): void {
        if (!this.errors.some((e) => e.message === message && e.line === line)) this.errors.push({ line, message });
    }
}

/** The env `parsePlatformioIni` describes: the first `[env:*]`, else `[env]`. */
function pickEnv(p: Parsed): string | null {
    for (const name of p.sections.keys()) if (name.startsWith("env:")) return name;
    return p.sections.has("env") ? "env" : null;
}

export function parsePlatformioIni(text: string): PlatformioIni {
    const parsed = readConfig(text);
    const config = new ProjectConfig(parsed);
    const sections = [...(parsed.defaults.options.size ? [parsed.defaults] : []), ...parsed.sections.values()]
        .sort((a, b) => a.line - b.line)
        .map((s) => ({ name: s.name, options: [...s.options.values()].map((o) => ({ key: o.key, value: rawValue(o) })) }));

    const root = pickEnv(parsed);
    const env: PlatformioIni["env"] = { name: root?.startsWith("env:") ? root.slice(4) : null, frameworks: [], libDeps: [], buildFlags: [], libIgnore: [], unsupported: [] };
    if (root) {
        const str = (o: string) => {
            const v = config.tryGet(root, o);
            return v === undefined || v === null ? undefined : String(v);
        };
        const list = (o: string) => {
            const v = config.tryGet(root, o);
            return Array.isArray(v) ? v : [];
        };
        const set = <K extends keyof PlatformioIni["env"]>(k: K, v: PlatformioIni["env"][K] | undefined) => {
            if (v !== undefined) env[k] = v;
        };
        set("platform", str("platform"));
        set("board", str("board"));
        env.frameworks = list("framework");
        if (config.find(root, "framework")) set("framework", env.frameworks.join(", "));
        env.libDeps = list("lib_deps");
        env.buildFlags = list("build_flags");
        env.libIgnore = list("lib_ignore");
        set("libLdfMode", str("lib_ldf_mode"));
        set("libCompatMode", str("lib_compat_mode"));
        set("libArchive", str("lib_archive"));
        const libDepsNames = ["lib_deps", ...ENV_OPTIONS.lib_deps!.oldnames!];
        env.unsupported = config
            .options(root)
            .filter((k) => !SUPPORTED.has(k) && !libDepsNames.includes(k) && !SUPPORTED_PREFIXES.some((p) => k.startsWith(p)));
    }
    const errors = [...parsed.errors, ...config.errors].sort((a, b) => a.line - b.line);
    return { sections, env, errors };
}

// --- setLibDeps --------------------------------------------------------------------------------

/**
 * Rewrites the `lib_deps` of the env `parsePlatformioIni` picks (the first `[env:*]`, else
 * `[env]`, else a new `[env]` appended at the end): one dep per indented line, rest of the file
 * untouched byte for byte. An empty list removes the option, or writes `lib_deps =` when the env
 * would otherwise inherit deps from `[env]`/`extends`.
 */
export function setLibDeps(text: string, deps: string[]): string {
    const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = text.slice(bom.length);
    const parsed = readConfig(body);
    const eol = /\r\n|\r|\n/.exec(body)?.[0] ?? "\n";
    const lines: Array<{ text: string; eol: string }> = [];
    for (const m of body.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
        if (m.index === body.length && m[0] === "" && lines.length) break;
        lines.push({ text: m[1]!, eol: m[2]! });
    }

    const root = pickEnv(parsed);
    const names = ["lib_deps", ...ENV_OPTIONS.lib_deps!.oldnames!];
    const block = (key: string, indent: string) => [`${key} =`, ...deps.map((d) => indent + d)];

    if (!root) {
        if (!deps.length) return text;
        const sep = body === "" ? "" : body.endsWith("\n") || body.endsWith("\r") ? eol : eol + eol;
        return bom + body + sep + ["[env]", ...block("lib_deps", "    ")].join(eol) + eol;
    }

    const section = parsed.sections.get(root)!;
    const own = [...section.options.values()].find((o) => names.includes(o.key));
    const config = new ProjectConfig(parsed);
    const inherited = [...config.walk(root)].some((h) => h.section !== root && names.includes(h.opt.key));

    let start: number; // 0-based index of the first replaced line
    let end: number; // 0-based index after the last replaced line
    let key = "lib_deps";
    let indent = "    ";
    if (own) {
        start = own.line - 1;
        end = own.lastLine;
        key = own.key;
        for (let i = start + 1; i < end; i++) {
            const t = lines[i]!.text;
            if (t.trim() && !/^\s*[#;]/.test(t)) {
                indent = /^\s*/.exec(t)![0];
                break;
            }
        }
    } else {
        let last = section.line;
        for (const o of section.options.values()) last = Math.max(last, o.lastLine);
        start = end = last;
    }
    let replacement: string[];
    if (deps.length) replacement = block(key, indent);
    else if (inherited) replacement = [`${key} =`];
    else if (own) replacement = [];
    else return text;

    const before = lines.slice(0, start);
    const after = lines.slice(end);
    const rep = replacement.map((r) => ({ text: r, eol }));
    // Inserting behind a last line without a newline: give it one.
    const tail = before[before.length - 1];
    if (rep.length && tail && !tail.eol) before[before.length - 1] = { ...tail, eol };
    // A replaced block at the very end of a file without a final newline keeps that style.
    if (rep.length && !after.length && end > start && !lines[end - 1]!.eol) rep[rep.length - 1]!.eol = "";
    return bom + [...before, ...rep, ...after].map((l) => l.text + l.eol).join("");
}
