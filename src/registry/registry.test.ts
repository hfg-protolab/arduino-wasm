import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { selectLibraries } from "../ldf";
import type { LibraryEntry } from "../manifest";
import { RegistryClient, type RegistryPackage } from "./client";
import { libraryFromPackage, packageRoot } from "./library";
import { LibraryProblemError, problemMessage, resolveLibDeps } from "./resolve";
import { sha256Hex } from "./tar";
import { matchSrcFiles, SRC_BUILD_EXT } from "./srcfilter";

const enc = new TextEncoder();

/** ustar writer (names ≤ 100 bytes). */
function tar(files: Record<string, string>): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [name, text] of Object.entries(files)) {
        const data = enc.encode(text);
        const h = new Uint8Array(512);
        const put = (at: number, s: string) => h.set(enc.encode(s), at);
        const oct = (at: number, len: number, n: number) => put(at, n.toString(8).padStart(len - 1, "0") + "\0");
        put(0, name);
        oct(100, 8, 0o644);
        oct(108, 8, 0);
        oct(116, 8, 0);
        oct(124, 12, data.length);
        oct(136, 12, 0);
        h[156] = "0".charCodeAt(0);
        put(257, "ustar\u000000");
        put(148, "        ");
        put(148, h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ");
        parts.push(h);
        const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
        body.set(data);
        parts.push(body);
    }
    parts.push(new Uint8Array(1024));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

const filesOf = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));

describe("src_filter (fs.match_src_files)", () => {
    const files = ["a.cpp", "b.c", "x.h", ".hidden.cpp", "src/m.cpp", "src/sub/n.S", "src/.git/o.c", "examples/e/e.ino", "examples/e/e.cpp", "utility/u.c", "test/t.cpp"];
    test("default + library exclusions", () => {
        const f = ["+<*>", "-<.git/>", "-<.svn/>", "-<example/>", "-<examples/>", "-<test/>", "-<tests/>"];
        expect(matchSrcFiles(files, "", f, SRC_BUILD_EXT)).toEqual(["a.cpp", "b.c", "src/.git/o.c", "src/m.cpp", "src/sub/n.S", "utility/u.c"]); // only a top-level .git is excluded (glob)
        expect(matchSrcFiles(files, "src", f, SRC_BUILD_EXT)).toEqual(["m.cpp", "sub/n.S"]);
    });
    test("Arduino filter without src/: top level and utility/ only", () => {
        const f = [...SRC_BUILD_EXT.filter((e) => e.toLowerCase() !== "asm").flatMap((e) => [`+<*.${e}>`, `+<utility/*.${e}>`])];
        expect(matchSrcFiles(files, "", f, SRC_BUILD_EXT)).toEqual(["a.cpp", "b.c", "utility/u.c"]);
    });
    test("** and exclusions, character classes", () => {
        expect(matchSrcFiles(files, "", "+<**/*.c> -<utility/>", SRC_BUILD_EXT)).toEqual(["b.c"]);
        expect(matchSrcFiles(files, "", "+<[ab].*>", undefined)).toEqual(["a.cpp", "b.c"]);
    });
});

describe("library model (piolib.py)", () => {
    const ctx = { frameworks: ["arduino"], platform: "atmelavr", storage: "/work/project/.pio/libdeps/uno", cliStorage: ".pio/libdeps/uno", order: 150000 };
    test("Arduino library with src/: include dir src, sources below src", () => {
        const l = libraryFromPackage(filesOf({ "library.properties": "name=Foo\nversion=1.0.0\ndepends=Bar\n", "src/Foo.h": "#include <Bar.h>\n", "src/Foo.cpp": '#include "Foo.h"\n', "examples/x/x.ino": "" }), { name: "Foo", version: "1.0.0", owner: "me", dirName: "Foo" }, ctx);
        expect(l.build.kind).toBe("arduino");
        expect(l.entry.includeDirs).toEqual([".pio/libdeps/uno/Foo/src"]);
        expect(l.entry.scan!.absIncludeDirs).toEqual(["/work/project/.pio/libdeps/uno/Foo/src"]);
        expect(l.build.sources).toEqual(["Foo.cpp"]);
        expect(l.entry.scan!.dependencies).toBeUndefined(); // Arduino builders leave depends to the LDF
    });
    test("library.json: srcFilter, includeDir, flags, dependencies, frameworks", () => {
        const l = libraryFromPackage(
            filesOf({ "library.json": JSON.stringify({ name: "J", version: "2.0.0", frameworks: "arduino", dependencies: { "x/Dep": "^1.0.0" }, build: { flags: "-DJ_OPT=1 -Iextra", srcFilter: "+<*> -<skip/>", includeDir: "inc" } }), "inc/J.h": "", "src/J.cpp": "", "src/skip/s.cpp": "", "extra/e.h": "" }),
            { name: "J", version: "2.0.0", dirName: "J" },
            ctx,
        );
        expect(l.build.kind).toBe("platformio");
        expect(l.entry.includeDirs).toEqual([".pio/libdeps/uno/J/inc", ".pio/libdeps/uno/J/src", ".pio/libdeps/uno/J/extra"]);
        expect(l.build.sources).toEqual(["J.cpp"]);
        expect(l.build.flags).toEqual(["-DJ_OPT=1"]);
        expect(l.entry.scan!.dependencies).toEqual([{ owner: "x", name: "Dep", version: "^1.0.0" }]);
        expect(l.incompatible).toBeUndefined();
    });
    test("framework-incompatible and unsupported libraries", () => {
        const idf = libraryFromPackage(filesOf({ "library.json": JSON.stringify({ name: "I", frameworks: ["espidf"] }), "a.c": "" }), { name: "I", version: "1.0.0", dirName: "I" }, ctx);
        expect(idf.incompatible).toContain("espidf");
        const scr = libraryFromPackage(filesOf({ "library.json": JSON.stringify({ name: "S", build: { extraScript: "x.py" } }), "a.c": "" }), { name: "S", version: "1.0.0", dirName: "S" }, ctx);
        expect(scr.unsupported).toContain("extraScript");
    });
    test("package root: the first dir with a manifest", () => {
        expect(packageRoot(["pkg/library.properties", "pkg/src/a.h", "README"])).toBe("pkg");
        expect(packageRoot(["library.json", "x/library.properties"])).toBe("");
    });
});

/** A registry with packages built from file maps; counts requests. */
async function fakeRegistry(pkgs: Array<{ owner: string; name: string; versions: Record<string, Record<string, string>> }>) {
    const blobs = new Map<string, Uint8Array>();
    const meta = new Map<string, RegistryPackage>();
    for (const p of pkgs) {
        const versions = [];
        for (const [v, files] of Object.entries(p.versions)) {
            const tgz = new Uint8Array(gzipSync(tar(files)));
            const sha = await sha256Hex(tgz);
            const url = `https://dl.example/${p.owner}/${p.name}/${v}.tar.gz`;
            blobs.set(url, tgz);
            versions.push({ name: v, files: [{ name: `${p.name}-${v}.tar.gz`, size: tgz.length, checksum: { sha256: sha }, system: "*", download_url: url }] });
        }
        versions.reverse();
        meta.set(`${p.owner}/${p.name}`.toLowerCase(), { id: meta.size + 1, type: "library", owner: { username: p.owner }, name: p.name, version: versions[0]!, versions });
    }
    const requests: string[] = [];
    const fetchFn = async (url: string) => {
        requests.push(url);
        if (blobs.has(url)) return new Response(blobs.get(url)! as BodyInit);
        const u = new URL(url);
        const pm = /\/v3\/packages\/([^/]+)\/library\/([^/]+)$/.exec(u.pathname);
        if (pm) {
            const p = meta.get(`${decodeURIComponent(pm[1]!)}/${decodeURIComponent(pm[2]!)}`);
            return p ? Response.json(p) : new Response("{}", { status: 404 });
        }
        if (u.pathname.endsWith("/v3/search")) {
            const q = u.searchParams.get("query")!;
            const name = /name:"([^"]+)"/.exec(q)?.[1];
            const items = [...meta.values()].filter((p) => !name || p.name.toLowerCase() === name);
            return Response.json({ total: items.length, items });
        }
        return new Response("?", { status: 500 });
    };
    return { client: new RegistryClient({ fetch: fetchFn, cacheStorage: false }), requests };
}

describe("resolver (pio pkg install for lib_deps)", () => {
    const ctx = (client: RegistryClient) => ({ client, platform: "atmelavr", frameworks: ["arduino"], builtinNames: ["Wire", "SPI"], packLibraries: [{ name: "SPI", origin: "framework", includeDirs: [], headers: [], deps: [] }] as LibraryEntry[] });
    test("highest matching version, manifest dependencies depth-first, builtins skipped, owner-less lib_deps not installed", async () => {
        const { client } = await fakeRegistry([
            { owner: "acme", name: "Top", versions: { "1.0.0": { "library.json": JSON.stringify({ name: "Top", version: "1.0.0" }) }, "1.4.2": { "library.json": JSON.stringify({ name: "Top", version: "1.4.2", dependencies: [{ owner: "acme", name: "Dep", version: "~2.1.0" }, { name: "Wire" }, { name: "Other" }] }) }, "2.0.0": { "library.json": JSON.stringify({ name: "Top", version: "2.0.0" }) } } },
            { owner: "acme", name: "Dep", versions: { "2.1.3": { "library.properties": "name=Dep\nversion=2.1.3\n" }, "2.2.0": { "library.properties": "name=Dep\nversion=2.2.0\n" } } },
            { owner: "bob", name: "Other", versions: { "0.1.0": { "library.properties": "name=Other\nversion=0.1.0\n" } } },
        ]);
        const r = await resolveLibDeps(["acme/Top@^1.0.0", "SPI"], ctx(client));
        expect(r.packages.map((p) => `${p.owner}/${p.name}@${p.version}`)).toEqual(["acme/Top@1.4.2", "acme/Dep@2.1.3", "bob/Other@0.1.0"]);
        expect(r.packages.map((p) => p.dirName)).toEqual(["Top", "Dep", "Other"]);
        expect(r.packages[0]!.direct).toBe(true);
    });
    test("problems: not found, no matching version, git URL", async () => {
        const { client } = await fakeRegistry([{ owner: "acme", name: "Top", versions: { "1.0.0": { "library.json": "{}" } } }]);
        const err = async (spec: string) => {
            try {
                await resolveLibDeps([spec], ctx(client));
            } catch (e) {
                return (e as LibraryProblemError).problem;
            }
            return null;
        };
        expect(await err("acme/Nope")).toEqual({ kind: "libNotFound", spec: "acme/Nope" });
        expect(await err("acme/Top@^3")).toEqual({ kind: "libVersion", spec: "acme/Top@^3", available: ["1.0.0"] });
        expect((await err("https://github.com/x/y.git"))?.kind).toBe("libUnsupported");
        expect(problemMessage({ kind: "libVersion", spec: "a/b@^3", available: ["1.0.0", "1.2.3"] })).toBe('library "a/b@^3": no version matches (available: 1.0.0, 1.2.3)');
        expect(problemMessage({ kind: "registryUnreachable" })).toBe("registry unreachable");
    });
    test("registryBase: API pass-through and sha-addressed downloads through the host", async () => {
        const urls: string[] = [];
        const { client: direct } = await fakeRegistry([{ owner: "acme", name: "Top", versions: { "1.0.0": { "library.json": "{}" } } }]);
        const pkg = (await direct.getPackage("acme", "Top"))!;
        const c = new RegistryClient({ registryBase: "http://hub.local/firmware-libs/", cacheStorage: false, fetch: async (u) => (urls.push(u), Response.json(pkg)) });
        await c.getPackage("Acme", "Top");
        expect(urls[0]).toBe("http://hub.local/firmware-libs/api/v3/packages/acme/library/top");
        const f = pkg.version.files[0]!;
        expect(c.downloadUrl(f)).toBe(`http://hub.local/firmware-libs/dl/${f.checksum.sha256}?url=${encodeURIComponent(f.download_url)}`);
    });
    test("a tarball with the wrong sha256 is rejected", async () => {
        const { client } = await fakeRegistry([{ owner: "acme", name: "Top", versions: { "1.0.0": { "library.json": "{}" } } }]);
        const pkg = (await client.getPackage("acme", "Top"))!;
        const bad = { ...pkg.version.files[0]!, checksum: { sha256: "0".repeat(64) } };
        await expect(client.tarball(bad)).rejects.toThrow(/sha256 mismatch/);
    });
});

describe("LDF with lib_deps", () => {
    const pack = (name: string, header: string, order: number, owner?: string): LibraryEntry => ({
        name,
        version: "1.1.15",
        ...(owner ? { owner } : {}),
        origin: "allowed",
        includeDirs: [`/opt/pio-libs/all/${name}`],
        headers: [header],
        deps: [],
        scan: { root: `/opt/pio-libs/all/${name}`, files: { [header]: [], [header.replace(".h", ".cpp")]: [`"${header}`] }, sources: [header.replace(".h", ".cpp")], order },
    });
    const ctx = { frameworks: ["arduino"], platform: "atmelavr", storage: "/work/project/.pio/libdeps/uno", cliStorage: ".pio/libdeps/uno" };
    test("an include resolves to the pack's copy (lib_extra_dirs come first); lib_deps pins the libdeps copy; library CPPPATH by PrependUnique", () => {
        const sensorPack = pack("Adafruit Unified Sensor", "Adafruit_Sensor.h", 1, "adafruit");
        const bme = libraryFromPackage(filesOf({ "library.properties": "name=Adafruit BME280 Library\n", "Adafruit_BME280.h": "#include <Adafruit_Sensor.h>\n", "Adafruit_BME280.cpp": '#include "Adafruit_BME280.h"\n' }), { name: "Adafruit BME280 Library", version: "2.3.0", owner: "adafruit", dirName: "Adafruit BME280 Library" }, { ...ctx, order: 150000 });
        const sensorReg = libraryFromPackage(filesOf({ "library.properties": "name=Adafruit Unified Sensor\n", "Adafruit_Sensor.h": "", "Adafruit_Sensor.cpp": '#include "Adafruit_Sensor.h"\n' }), { name: "Adafruit Unified Sensor", version: "1.1.9", owner: "adafruit", dirName: "Adafruit Unified Sensor" }, { ...ctx, order: 150001 });
        const libs = [sensorPack, bme.entry, sensorReg.entry];
        const ino = [{ path: "main.ino.cpp", content: "#include <Adafruit_BME280.h>\n" }];
        const r = selectLibraries(ino, libs, { libDeps: ["adafruit/Adafruit BME280 Library@2.3.0"] });
        expect(r.libraries.map((l) => `${l.name}@${l.version}`)).toEqual(["Adafruit Unified Sensor@1.1.15", "Adafruit BME280 Library@2.3.0"]);
        expect(r.libIncludeArgs!.get(bme.entry)).toEqual(["-I", ".pio/libdeps/uno/Adafruit BME280 Library", "-I", "/opt/pio-libs/all/Adafruit Unified Sensor"]);
        // pinning the older version: the libdeps copy is used
        const r2 = selectLibraries(ino, libs, { libDeps: ["adafruit/Adafruit BME280 Library@2.3.0", "adafruit/Adafruit Unified Sensor@1.1.9"] });
        expect(r2.libraries.map((l) => `${l.name}@${l.version}`)).toEqual(["Adafruit Unified Sensor@1.1.9", "Adafruit BME280 Library@2.3.0"]);
    });
});
