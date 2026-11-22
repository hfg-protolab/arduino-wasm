/**
 * Port of python-semanticversion 2.10 (`Version`, `SimpleSpec`), the version library PlatformIO
 * 6.2 resolves library requirements with, plus PlatformIO's `cast_version_to_semver`.
 *
 * - `Version.parse` is the strict SemVer 2.0 grammar: no leading zeros in major/minor/patch or
 *   in numeric prerelease identifiers (build identifiers may have them), no empty identifiers.
 * - Ordering (`compare`) ignores build metadata; equality (`equals`) does not.
 * - `SimpleSpec` is a comma-separated AND of blocks `<op><major>[.<minor>[.<patch>]][-pre][+build]`
 *   with `*` wildcards. Blocks are not trimmed: `">=1.0.0, <2"` is invalid, exactly as in Python.
 *   `x`/`X` are listed as wildcards in the Python source but the block grammar never lets them
 *   through, so they are invalid here too.
 *
 * Python's `$` also matches before one trailing newline; the regexes below keep that quirk.
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-zA-Z.-]+))?(?:\+([0-9a-zA-Z.-]+))?\n?$/;
const COERCE_BASE_RE = /^\d+(?:\.\d+(?:\.\d+)?)?/;
const DIGITS_RE = /^[0-9]+$/;

function hasLeadingZero(value: string): boolean {
    return value.length > 1 && value[0] === "0" && DIGITS_RE.test(value);
}

function validateIdentifiers(ids: readonly string[], allowLeadingZeroes: boolean): void {
    for (const item of ids) {
        if (!item) throw new Error(`Invalid empty identifier '' in '${ids.join(".")}'`);
        if (!allowLeadingZeroes && hasLeadingZero(item)) throw new Error(`Invalid leading zero in identifier '${item}'`);
    }
}

/** One element of a precedence key: numeric < alphanumeric < "no prerelease" (MaxIdentifier). */
type Ident = { kind: 0; num: number } | { kind: 1; str: string } | { kind: 2 };

function identKey(parts: readonly string[]): Ident[] {
    if (!parts.length) return [{ kind: 2 }];
    return parts.map((p): Ident => (DIGITS_RE.test(p) ? { kind: 0, num: Number(p) } : { kind: 1, str: p }));
}

function cmpIdent(a: Ident, b: Ident): number {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.kind === 0 && b.kind === 0) return a.num === b.num ? 0 : a.num < b.num ? -1 : 1;
    if (a.kind === 1 && b.kind === 1) return a.str === b.str ? 0 : a.str < b.str ? -1 : 1;
    return 0;
}

function cmpNum(a: number, b: number): number {
    return a === b ? 0 : a < b ? -1 : 1;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

export class Version {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
    build: string[];

    /** Keyword construction (`Version(major=…, …)`): identifiers are validated like in Python. */
    constructor(major: number, minor: number, patch: number, prerelease: string[] = [], build: string[] = []) {
        validateIdentifiers(prerelease, false);
        validateIdentifiers(build, true);
        this.major = major;
        this.minor = minor;
        this.patch = patch;
        this.prerelease = prerelease;
        this.build = build;
    }

    /** Strict SemVer parsing (`Version("1.2.3-rc.1+b5")`); throws on anything else. */
    static parse(s: string): Version {
        if (!s) throw new Error(`Invalid empty version string: '${s}'`);
        const m = VERSION_RE.exec(s);
        if (!m) throw new Error(`Invalid version string: '${s}'`);
        const [, major, minor, patch, pre, build] = m;
        for (const [label, part] of [["major", major], ["minor", minor], ["patch", patch]] as const) {
            if (hasLeadingZero(part!)) throw new Error(`Invalid leading zero in ${label}: '${s}'`);
        }
        return new Version(Number(major), Number(minor), Number(patch), pre ? pre.split(".") : [], build ? build.split(".") : []);
    }

    /**
     * `Version.coerce`: missing minor/patch become 0, leading zeros are stripped, a 4th dotted
     * component or anything after `+` becomes build data, `-…` becomes the prerelease, and other
     * characters are replaced by `-` before strict parsing.
     */
    static coerce(s: string): Version {
        const m = COERCE_BASE_RE.exec(s);
        if (!m) throw new Error(`Version string lacks a numerical component: '${s}'`);
        let version = m[0];
        while ((version.match(/\./g) ?? []).length < 2) version += ".0";
        version = version
            .split(".")
            .map((part) => part.replace(/^0+/, "") || "0")
            .join(".");
        if (m[0].length === s.length) return Version.parse(version);

        const rest = s.slice(m[0].length).replace(/[^a-zA-Z0-9+.-]/g, "-");
        let prerelease: string;
        let build: string;
        const split = (r: string): [string, string] => {
            const i = r.indexOf("+");
            return i < 0 ? [r, ""] : [r.slice(0, i), r.slice(i + 1)];
        };
        if (rest[0] === "+" || rest[0] === ".") {
            prerelease = "";
            build = rest.slice(1);
        } else if (rest[0] === "-") {
            [prerelease, build] = split(rest.slice(1));
        } else {
            [prerelease, build] = split(rest);
        }
        build = build.replaceAll("+", ".");
        if (prerelease) version = `${version}-${prerelease}`;
        if (build) version = `${version}+${build}`;
        return Version.parse(version);
    }

    /** Precedence ordering without build metadata (`__lt__`/`__gt__`): -1, 0 or 1. */
    compare(o: Version): number {
        const c = cmpNum(this.major, o.major) || cmpNum(this.minor, o.minor) || cmpNum(this.patch, o.patch);
        if (c) return c;
        const a = identKey(this.prerelease);
        const b = identKey(o.prerelease);
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const r = cmpIdent(a[i]!, b[i]!);
            if (r) return r;
        }
        return cmpNum(a.length, b.length);
    }

    /** `__eq__`: all components including the build metadata. */
    equals(o: Version): boolean {
        return (
            this.major === o.major &&
            this.minor === o.minor &&
            this.patch === o.patch &&
            sameList(this.prerelease, o.prerelease) &&
            sameList(this.build, o.build)
        );
    }

    /** `truncate("prerelease")` drops the build, `truncate("patch")` also the prerelease. */
    truncate(level: "prerelease" | "patch"): Version {
        return new Version(this.major, this.minor, this.patch, level === "prerelease" ? this.prerelease : []);
    }

    nextMajor(): Version {
        if (this.prerelease.length && this.minor === 0 && this.patch === 0) return new Version(this.major, 0, 0);
        return new Version(this.major + 1, 0, 0);
    }

    nextMinor(): Version {
        if (this.prerelease.length && this.patch === 0) return new Version(this.major, this.minor, 0);
        return new Version(this.major, this.minor + 1, 0);
    }

    nextPatch(): Version {
        if (this.prerelease.length) return new Version(this.major, this.minor, this.patch);
        return new Version(this.major, this.minor, this.patch + 1);
    }

    toString(): string {
        let s = `${this.major}.${this.minor}.${this.patch}`;
        if (this.prerelease.length) s += `-${this.prerelease.join(".")}`;
        if (this.build.length) s += `+${this.build.join(".")}`;
        return s;
    }
}

/**
 * PlatformIO's `cast_version_to_semver(value, force=True)`: strict SemVer, else
 * `Version.coerce`, else a commit hash becomes `0.0.0+sha.<hash>` and anything else
 * `0.0.0+<value>` (which throws when the value is not a valid build identifier list).
 */
export function castVersion(value: string): Version {
    if (!value) throw new Error("castVersion: empty value");
    try {
        return Version.parse(value);
    } catch {}
    try {
        return Version.coerce(value);
    } catch {}
    if (/^[\da-f]+\n?$/i.test(value)) return Version.parse(`0.0.0+sha.${value}`);
    return Version.parse(`0.0.0+${value}`);
}

type Op = "==" | ">" | ">=" | "<" | "<=" | "!=";
type PrereleasePolicy = "natural" | "always" | "same-patch";
type BuildPolicy = "implicit" | "strict";

interface Clause {
    match(v: Version): boolean;
}

/**
 * `Range`: one comparison. Prerelease policy "natural" keeps `<1.2.3` from matching `1.2.3-a1`
 * ("always" lets it), "same-patch" only admits prereleases of the target's patch. Build policy
 * "implicit" ignores the build of the candidate; a target with a build forces "strict".
 */
class Range implements Clause {
    readonly buildPolicy: BuildPolicy;

    constructor(
        readonly operator: Op,
        readonly target: Version,
        readonly prereleasePolicy: PrereleasePolicy = "natural",
        buildPolicy: BuildPolicy = "implicit",
    ) {
        if (target.build.length && operator !== "==" && operator !== "!=") {
            throw new Error(`Invalid range ${operator}${target}: build numbers have no ordering.`);
        }
        this.buildPolicy = target.build.length ? "strict" : buildPolicy;
    }

    match(version: Version): boolean {
        const t = this.target;
        if (this.buildPolicy !== "strict") version = version.truncate("prerelease");
        if (version.prerelease.length) {
            const samePatch = t.truncate("patch").equals(version.truncate("patch"));
            if (this.prereleasePolicy === "same-patch" && !samePatch) return false;
        }
        const naturalPrereleaseOfTarget =
            version.prerelease.length > 0 &&
            this.prereleasePolicy === "natural" &&
            version.truncate("patch").equals(t.truncate("patch")) &&
            !t.prerelease.length;
        const strictEq = () => t.truncate("prerelease").equals(version.truncate("prerelease")) && sameList(version.build, t.build);
        switch (this.operator) {
            case "==":
                return this.buildPolicy === "strict" ? strictEq() : version.equals(t);
            case ">":
                return version.compare(t) > 0;
            case ">=":
                return version.compare(t) >= 0;
            case "<":
                if (naturalPrereleaseOfTarget) return false;
                return version.compare(t) < 0;
            case "<=":
                return version.compare(t) <= 0;
            case "!=":
                if (this.buildPolicy === "strict") return !strictEq();
                if (naturalPrereleaseOfTarget) return false;
                return !version.equals(t);
        }
    }
}

const allOf = (...cs: Clause[]): Clause => ({ match: (v) => cs.every((c) => c.match(v)) });
const anyOf = (...cs: Clause[]): Clause => ({ match: (v) => cs.some((c) => c.match(v)) });

const NAIVE_SPEC =
    /^(<|<=||=|==|>=|>|!=|\^|~|~=)(\*|0|[1-9][0-9]*)(?:\.(\*|0|[1-9][0-9]*)(?:\.(\*|0|[1-9][0-9]*))?)?(?:-([a-z0-9A-Z.-]*))?(?:\+([a-z0-9A-Z.-]*))?\n?$/;
const EMPTY_VALUES = new Set(["*", "x", "X"]);

/** `SimpleSpec.Parser.parse_block`: one comma-separated block → clause. */
function parseBlock(expr: string): Clause {
    const m = NAIVE_SPEC.exec(expr);
    if (!m) throw new Error(`Invalid simple spec component: '${expr}'`);
    const [, rawPrefix, majorT, minorT, patchT, prerel, build] = m;
    const prefix = rawPrefix === "=" || rawPrefix === "" ? "==" : rawPrefix!;
    const num = (t: string | undefined) => (t === undefined || EMPTY_VALUES.has(t) ? null : Number(t));
    const major = num(majorT);
    const minor = num(minorT);
    const patch = num(patchT);
    const invalid = () => new Error(`Invalid simple spec: '${expr}'`);

    let target: Version;
    if (major === null) {
        target = new Version(0, 0, 0);
        if (prefix !== "==" && prefix !== ">=") throw invalid();
    } else if (minor === null) target = new Version(major, 0, 0);
    else if (patch === null) target = new Version(major, minor, 0);
    else target = new Version(major, minor, patch, prerel ? prerel.split(".") : [], build ? build.split(".") : []);

    if ((major === null || minor === null || patch === null) && (prerel || build)) throw invalid();
    if (build !== undefined && prefix !== "==" && prefix !== "!=") throw invalid();

    switch (prefix) {
        case "^": {
            const high = target.major ? target.nextMajor() : target.minor ? target.nextMinor() : target.nextPatch();
            return allOf(new Range(">=", target), new Range("<", high));
        }
        case "~":
            return allOf(new Range(">=", target), new Range("<", minor === null ? target.nextMajor() : target.nextMinor()));
        case "~=":
            return allOf(
                new Range(">=", target),
                new Range("<", minor === null || patch === null ? target.nextMajor() : target.nextMinor()),
            );
        case "==":
            if (major === null) return new Range(">=", target);
            if (minor === null) return allOf(new Range(">=", target), new Range("<", target.nextMajor()));
            if (patch === null) return allOf(new Range(">=", target), new Range("<", target.nextMinor()));
            if (build === "") return new Range("==", target, "natural", "strict");
            return new Range("==", target);
        case "!=":
            if (minor === null) return anyOf(new Range("<", target), new Range(">=", target.nextMajor()));
            if (patch === null) return anyOf(new Range("<", target), new Range(">=", target.nextMinor()));
            if (prerel === "") return new Range("!=", target, "always");
            if (build === "") return new Range("!=", target, "natural", "strict");
            return new Range("!=", target);
        case ">":
            if (minor === null) return new Range(">=", target.nextMajor());
            if (patch === null) return new Range(">=", target.nextMinor());
            return new Range(">", target);
        case ">=":
            return new Range(">=", target);
        case "<":
            if (prerel === "") return new Range("<", target, "always");
            return new Range("<", target);
        default: // "<="
            if (minor === null) return new Range("<", target.nextMajor());
            if (patch === null) return new Range("<", target.nextMinor());
            return new Range("<=", target);
    }
}

/** `semantic_version.SimpleSpec`: `^1.2.3`, `~1.2`, `>=1.0.0,<2`, `1.2`, `*`, `!=1.2.3`, … */
export class SimpleSpec {
    readonly expression: string;
    private readonly clause: Clause;

    constructor(expression: string) {
        this.expression = expression;
        const clauses: Clause[] = [];
        for (const block of expression.split(",")) {
            if (!NAIVE_SPEC.test(block)) throw new Error(`Invalid simple block '${block}'`);
            clauses.push(parseBlock(block));
        }
        this.clause = allOf(...clauses);
    }

    match(v: Version): boolean {
        return this.clause.match(v);
    }

    toString(): string {
        return this.expression;
    }
}

export function isValidSpec(expr: string): boolean {
    try {
        new SimpleSpec(expr);
        return true;
    } catch {
        return false;
    }
}
