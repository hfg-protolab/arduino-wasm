import { describe, expect, test } from "bun:test";
import { humanizeLibSpec, parseLibSpec, serializeLibDep } from "./spec";

/** [raw, PackageSpec fields, humanize()] as computed by PlatformIO 6.2 (no local paths exist). */
const CASES: Array<[string, Record<string, unknown>, string]> = [
    ["adafruit/Adafruit BME280 Library@^2.3.0", {"owner": "adafruit", "name": "Adafruit BME280 Library", "requirements": "^2.3.0"}, "adafruit/Adafruit BME280 Library @ ^2.3.0"],
    ["Adafruit BME280 Library", {"name": "Adafruit BME280 Library"}, "Adafruit BME280 Library"],
    ["Name@~1.2", {"name": "Name", "requirements": "~1.2"}, "Name @ ~1.2"],
    ["owner/Name", {"owner": "owner", "name": "Name"}, "owner/Name"],
    ["id=123", {"id": 123}, "id:123"],
    ["123", {"id": 123}, "id:123"],
    ["https://github.com/x/y.git", {"name": "y", "uri": "git+https://github.com/x/y.git"}, "git+https://github.com/x/y.git"],
    ["https://github.com/x/y", {"name": "y", "uri": "git+https://github.com/x/y"}, "git+https://github.com/x/y"],
    ["https://example.com/foo.zip", {"name": "foo", "uri": "https://example.com/foo.zip"}, "https://example.com/foo.zip"],
    ["symlink:///home/me/lib", {"name": "lib", "uri": "symlink:///home/me/lib"}, "symlink:///home/me/lib"],
    ["symlink://../mylib", {"name": "mylib", "uri": "symlink://../mylib"}, "symlink://../mylib"],
    ["file:///tmp/x.zip", {"name": "x", "uri": "file:///tmp/x.zip"}, "file:///tmp/x.zip"],
    ["MyName=owner/lib@1.0", {"owner": "owner", "name": "lib", "requirements": "1.0", "customName": true}, "owner/lib @ 1.0"],
    ["MyName=https://github.com/x/y.git#v1", {"name": "MyName", "uri": "git+https://github.com/x/y.git#v1", "customName": true}, "git+https://github.com/x/y.git#v1"],
    ["Name@1.2.3", {"name": "Name", "requirements": "1.2.3"}, "Name @ 1.2.3"],
    ["Some Lib v1.2 by Foo@>=1.0.0", {"name": "Some Lib v1.2 by Foo", "requirements": ">=1.0.0"}, "Some Lib v1.2 by Foo @ >=1.0.0"],
    ["  Name @ ^1.0.0  ", {"name": "Name", "requirements": "^1.0.0"}, "Name @ ^1.0.0"],
    ["Name@", {"name": "Name"}, "Name"],
    ["git@github.com:x/y.git", {"name": "y", "uri": "git+git@github.com:x/y.git"}, "git+git@github.com:x/y.git"],
    ["https://github.com/x/y/archive/refs/heads/main.zip", {"name": "y", "uri": "https://github.com/x/y/archive/refs/heads/main.zip"}, "https://github.com/x/y/archive/refs/heads/main.zip"],
    ["https://github.com/x/y.git#v1.2", {"name": "y", "uri": "git+https://github.com/x/y.git#v1.2"}, "git+https://github.com/x/y.git#v1.2"],
    ["https://os.mbed.com/users/u/code/pkg/", {"name": "pkg", "uri": "hg+https://os.mbed.com/users/u/code/pkg/"}, "hg+https://os.mbed.com/users/u/code/pkg/"],
    ["owner/Name@^1.0", {"owner": "owner", "name": "Name", "requirements": "^1.0"}, "owner/Name @ ^1.0"],
    ["Name@https://example.com/x.zip", {"name": "x", "uri": "Name@https://example.com/x.zip"}, "Name@https://example.com/x.zip"],
    ["git+https://example.com/x.git", {"name": "x", "uri": "git+https://example.com/x.git"}, "git+https://example.com/x.git"],
    ["id=abc", {"name": "abc"}, "abc"],
    ["MyName=Foo", {"name": "Foo", "customName": true}, "Foo"],
    ["https://github.com/x/y/tree/dev", {"name": "y", "uri": "git+https://github.com/x/y/tree/dev"}, "git+https://github.com/x/y/tree/dev"],
    ["Name@>=1.0,<2", {"name": "Name", "requirements": ">=1.0,<2"}, "Name @ >=1.0,<2"],
    ["owner/name/extra", {"name": "extra", "uri": "owner/name/extra"}, "owner/name/extra"],
    ["https://example.com/a/b.tar.gz?x=1", {"name": "b", "uri": "https://example.com/a/b.tar.gz?x=1"}, "https://example.com/a/b.tar.gz?x=1"],
];

describe("parseLibSpec", () => {
    for (const [raw, fields, human] of CASES) {
        test(JSON.stringify(raw), () => {
            const s = parseLibSpec(raw);
            const { raw: r, ...rest } = s;
            expect(r).toBe(raw);
            expect(rest).toEqual(fields);
            expect(humanizeLibSpec(s)).toBe(human);
        });
    }

    test("invalid requirements throw (SemanticVersionError)", () => {
        expect(() => parseLibSpec("Name@>=1.0.0, <2")).toThrow();
        expect(() => parseLibSpec("Name@foo")).toThrow();
    });
});

describe("serializeLibDep (as_dependency)", () => {
    test("adafruit/Adafruit GFX@^1.2.3", () => expect(serializeLibDep({"owner": "adafruit", "name": "Adafruit GFX", "version": "^1.2.3"})).toBe("adafruit/Adafruit GFX@^1.2.3"));
    test("Name", () => expect(serializeLibDep({"name": "Name"})).toBe("Name"));
    test("owner/Name", () => expect(serializeLibDep({"owner": "owner", "name": "Name"})).toBe("owner/Name"));
    test("Foo=https://github.com/x/foo.git", () => expect(serializeLibDep({"name": "Foo", "version": "https://github.com/x/foo.git"})).toBe("Foo=https://github.com/x/foo.git"));
    test("o/foo bar", () => expect(serializeLibDep({"owner": "o", "name": "Foo", "version": "foo bar"})).toBe("o/foo bar"));
    test("N@*", () => expect(serializeLibDep({"name": "N", "version": "*"})).toBe("N@*"));
    test("empty version is no requirement", () => expect(serializeLibDep({ name: "N", version: "" })).toBe("N"));
});
