import { describe, expect, test } from "bun:test";
import { castVersion, isValidSpec, SimpleSpec, Version } from "./semver";

const VERSIONS = [
    "0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2",
    "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0", "1.2.3-alpha",
];

/** Expected matches computed with python-semanticversion 2.10 (`Version(v) in SimpleSpec(s)`); null = ValueError. */
const SPEC_TABLE: Array<[string, string[] | null]> = [
    ["^1.2.3", ["1.2.3", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99"]],
    ["^0.2.3", ["0.2.9"]],
    ["^0.0.3", ["0.0.3"]],
    ["~1.2", ["1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.2.3-alpha"]],
    ["~1", ["1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["~1.2.3", ["1.2.3", "1.2.3+build.1", "1.2.3+b", "1.2.4"]],
    ["~=1.2", ["1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["~=1.2.3", ["1.2.3", "1.2.3+build.1", "1.2.3+b", "1.2.4"]],
    ["1.2", ["1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.2.3-alpha"]],
    ["1", ["1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["1.2.3", ["1.2.3", "1.2.3+build.1", "1.2.3+b"]],
    ["=1.2.3", ["1.2.3", "1.2.3+build.1", "1.2.3+b"]],
    ["==1.2.3", ["1.2.3", "1.2.3+build.1", "1.2.3+b"]],
    ["*", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0", "1.2.3-alpha"]],
    [">=*", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0", "1.2.3-alpha"]],
    [">=1.0.0,<2", ["1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["<2.0.0", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["<2.0.0-", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "1.2.3-alpha"]],
    [">1.2", ["1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0"]],
    [">1", ["2.0.0", "3.0.0"]],
    [">1.2.3", ["1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0"]],
    ["<=1.2", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.2.3-alpha"]],
    ["<=1", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["<=1.2.3", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.3-alpha"]],
    ["!=1.2.3", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0"]],
    ["!=1.2", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0"]],
    ["!=1", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "2.0.0", "3.0.0"]],
    ["!=1.2.3-", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0", "1.2.3-alpha"]],
    ["!=1.2.3+", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "2.0.0-rc1", "2.0.0", "3.0.0", "1.2.3-alpha"]],
    ["==1.2.3+", ["1.2.3"]],
    ["1.2.3+build.1", ["1.2.3+build.1"]],
    ["^1.2.3-rc1", ["1.2.3", "1.2.3-rc1", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99"]],
    [">=1.0.0, <2", null],
    ["1.x", null],
    ["^*", null],
    ["~*", null],
    ["", null],
    [">=1.2.3+b", null],
    ["1.2.*", ["1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.2.3-alpha"]],
    ["1.*", ["1.0.0", "1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.3.0", "1.9.0", "1.99.99", "1.2.3-alpha"]],
    ["1.2-", ["1.2.0", "1.2.2", "1.2.3", "1.2.3-rc1", "1.2.3-rc.1", "1.2.3-rc.2", "1.2.3+build.1", "1.2.3+b", "1.2.4", "1.2.3-alpha"]],
    ["1.2.3-01", null],
    ["1.2.3-a..b", null],
    ["<1.2.3-rc.2", ["0.0.3", "0.0.4", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.2.2", "1.2.3-rc.1", "1.2.3-alpha"]],
    ["01.2.3", null],
];

describe("SimpleSpec", () => {
    for (const [spec, expected] of SPEC_TABLE) {
        test(`'${spec}'`, () => {
            if (expected === null) {
                expect(() => new SimpleSpec(spec)).toThrow();
                expect(isValidSpec(spec)).toBe(false);
                return;
            }
            const s = new SimpleSpec(spec);
            expect(VERSIONS.filter((v) => s.match(Version.parse(v)))).toEqual(expected);
            expect(s.toString()).toBe(spec);
        });
    }

    test("caret / tilde boundaries", () => {
        const m = (s: string, v: string) => new SimpleSpec(s).match(Version.parse(v));
        expect(m("^1.2.3", "1.9.0")).toBe(true);
        expect(m("^1.2.3", "2.0.0")).toBe(false);
        expect(m("^0.2.3", "0.2.99")).toBe(true);
        expect(m("^0.2.3", "0.3.0")).toBe(false);
        expect(m("^0.0.3", "0.0.4")).toBe(false);
        expect(m("~1.2", "1.3.0")).toBe(false);
        expect(m("1.2", "1.2.0")).toBe(true);
        expect(m(">=1.0.0,<2", "2.0.0")).toBe(false);
        expect(m("<2.0.0", "2.0.0-rc1")).toBe(false);
        expect(m("<2.0.0-", "2.0.0-rc1")).toBe(true);
    });
});

describe("Version", () => {
    test("strict parse", () => {
        const v = Version.parse("1.0.0-beta.2+exp.sha.5114f85");
        expect([v.major, v.minor, v.patch]).toEqual([1, 0, 0]);
        expect(v.prerelease).toEqual(["beta", "2"]);
        expect(v.build).toEqual(["exp", "sha", "5114f85"]);
        expect(v.toString()).toBe("1.0.0-beta.2+exp.sha.5114f85");
        expect(Version.parse("1.2.3+001").build).toEqual(["001"]);
        // Python's `$` also matches before a final newline.
        expect(Version.parse("1.2.3\n").toString()).toBe("1.2.3");
        for (const bad of ["", "1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-a..b", "1.2.3+", "1.2.3 "]) {
            expect(() => Version.parse(bad)).toThrow();
        }
    });

    test("precedence (semver.org §11) ignores build, equality does not", () => {
        const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.9.0", "1.10.0", "2.0.0"];
        for (let i = 0; i + 1 < order.length; i++) {
            expect(Version.parse(order[i]!).compare(Version.parse(order[i + 1]!))).toBe(-1);
            expect(Version.parse(order[i + 1]!).compare(Version.parse(order[i]!))).toBe(1);
        }
        expect(Version.parse("1.0.0-1").compare(Version.parse("1.0.0-a"))).toBe(-1);
        expect(Version.parse("1.0.0+a").compare(Version.parse("1.0.0+b"))).toBe(0);
        expect(Version.parse("1.0.0+a").equals(Version.parse("1.0.0+b"))).toBe(false);
        expect(Version.parse("1.0.0+a").equals(Version.parse("1.0.0+a"))).toBe(true);
    });

    test("coerce", () => {
        expect(Version.coerce("0.1").toString()).toBe("0.1.0");
        expect(Version.coerce("0.1.2.3").toString()).toBe("0.1.2+3");
        expect(Version.coerce("0.1.2.3+4").toString()).toBe("0.1.2+3.4");
        expect(Version.coerce("0.1+2-3+4_5").toString()).toBe("0.1.0+2-3.4-5");
        expect(Version.coerce("01.02.03").toString()).toBe("1.2.3");
        expect(Version.coerce("1.0b1").toString()).toBe("1.0.0-b1");
        expect(() => Version.coerce("v1")).toThrow();
        expect(() => Version.coerce("1.0.0-01")).toThrow();
    });
});

describe("castVersion (cast_version_to_semver, force=True)", () => {
    /** Expected values computed with PlatformIO 6.2 / semantic_version 2.10. */
    const CASES: Array<[string, string | null]> = [
        ["1.0", "1.0.0"],
        ["v1", "0.0.0+v1"],
        ["abc123", "0.0.0+sha.abc123"],
        ["1.2.3.4", "1.2.3+4"],
        ["1.2.3", "1.2.3"],
        ["01.02.03", "1.2.3"],
        ["1.0-beta", "1.0.0-beta"],
        ["1.0.0-beta+exp.sha.5114f85", "1.0.0-beta+exp.sha.5114f85"],
        ["1.2.3.4.5", "1.2.3+4.5"],
        ["2.3", "2.3.0"],
        ["1.0b1", "1.0.0-b1"],
        ["1.2_3", "1.2.0-3"],
        ["1.2.3+4+5", "1.2.3+4.5"],
        ["1.2.3 foo", "1.2.3-foo"],
        ["1.0.0-01", "0.0.0+1.0.0-01"],
        ["20220101", "20220101.0.0"],
        ["v1.2.3", "0.0.0+v1.2.3"],
        ["1.2.3\n", "1.2.3"],
        ["0.1+2-3+4_5", "0.1.0+2-3.4-5"],
        ["1.2.3-rc.1", "1.2.3-rc.1"],
    ];
    for (const [input, expected] of CASES) {
        test(JSON.stringify(input), () => {
            if (expected === null) expect(() => castVersion(input)).toThrow();
            else expect(castVersion(input).toString()).toBe(expected);
        });
    }
    test("invalid leftovers throw like Python", () => {
        expect(() => castVersion("")).toThrow();
        expect(() => castVersion("foo bar")).toThrow();
    });
});
