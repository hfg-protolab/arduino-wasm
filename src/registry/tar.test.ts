import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { gunzip, readTar, sha256Hex } from "./tar";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Minimal ustar header writer (name ≤ 100, optional prefix, octal fields, checksum). */
function header(name: string, size: number, type: string, opts: { prefix?: string; corrupt?: boolean } = {}): Uint8Array {
    const h = new Uint8Array(512);
    const put = (at: number, s: string) => h.set(enc.encode(s), at);
    const oct = (at: number, len: number, n: number) => put(at, n.toString(8).padStart(len - 1, "0") + "\0");
    put(0, name);
    oct(100, 8, 0o644);
    oct(108, 8, 0);
    oct(116, 8, 0);
    oct(124, 12, size);
    oct(136, 12, 0);
    h[156] = type.charCodeAt(0);
    put(257, "ustar\u000000");
    if (opts.prefix) put(345, opts.prefix);
    put(148, "        ");
    const sum = h.reduce((a, b) => a + b, 0) + (opts.corrupt ? 1 : 0);
    put(148, sum.toString(8).padStart(6, "0") + "\0 ");
    return h;
}

function pad(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
    out.set(data);
    return out;
}

type Member = { name: string; data?: string | Uint8Array; type?: string; prefix?: string; corrupt?: boolean; size?: number };

function tar(members: Member[], end = true): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const m of members) {
        const data = typeof m.data === "string" ? enc.encode(m.data) : (m.data ?? new Uint8Array(0));
        parts.push(header(m.name, m.size ?? data.length, m.type ?? "0", m), pad(data));
    }
    if (end) parts.push(new Uint8Array(1024));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

const pax = (records: Record<string, string>) =>
    Object.entries(records)
        .map(([k, v]) => {
            const body = ` ${k}=${v}\n`;
            let n = enc.encode(body).length + 1;
            while (String(n).length + enc.encode(body).length !== n) n++;
            return `${n}${body}`;
        })
        .join("");

const files = (entries: { path: string; data: Uint8Array }[]) => entries.map((e) => [e.path, dec.decode(e.data)]);

describe("readTar", () => {
    test("ustar: prefix, ./ normalisation, dirs and links skipped", () => {
        const t = tar([
            { name: "./library.json", data: '{"name":"x"}' },
            { name: "src", type: "5" },
            { name: "src/", type: "\0" },
            { name: "a.cpp", data: "int a;", prefix: "src" },
            { name: "link", type: "2" },
            { name: "hard", type: "1" },
            { name: "src/./b.h", data: "b" },
        ]);
        expect(files(readTar(t))).toEqual([
            ["library.json", '{"name":"x"}'],
            ["src/a.cpp", "int a;"],
            ["src/b.h", "b"],
        ]);
    });

    test("GNU long names (././@LongLink, type L)", () => {
        const long = `${"d".repeat(80)}/${"e".repeat(80)}/file.txt`;
        const t = tar([{ name: "././@LongLink", type: "L", data: long + "\0" }, { name: long.slice(0, 99), data: "long" }]);
        expect(files(readTar(t))).toEqual([[long, "long"]]);
    });

    test("pax: x applies to the next member, g to all following, path= and size=", () => {
        const t = tar([
            { name: "PaxHeader", type: "x", data: pax({ path: "ünï/ćödé.h/" }) },
            { name: "short", data: "u" },
            { name: "plain.txt", data: "p" },
            { name: "GlobalHead", type: "g", data: pax({ comment: "c" }) },
            { name: "after.txt", data: "a" },
            { name: "PaxHeader", type: "x", data: pax({ size: "3" }) },
            { name: "sized.txt", data: "xyz", size: 0 },
            { name: "tail.txt", data: "t" },
        ]);
        expect(files(readTar(t))).toEqual([
            ["ünï/ćödé.h", "u"],
            ["plain.txt", "p"],
            ["after.txt", "a"],
            ["sized.txt", "xyz"],
            ["tail.txt", "t"],
        ]);
    });

    test("unknown member types are files, a later duplicate wins", () => {
        const t = tar([{ name: "a", data: "1" }, { name: "weird", type: "Z", data: "w" }, { name: "a", data: "2" }]);
        expect(files(readTar(t))).toEqual([["weird", "w"], ["a", "2"]]);
    });

    test("absolute paths and .. are rejected", () => {
        expect(() => readTar(tar([{ name: "/etc/passwd", data: "x" }]))).toThrow();
        expect(() => readTar(tar([{ name: "a/../../x", data: "x" }]))).toThrow();
        expect(() => readTar(tar([{ name: "x", type: "x", data: pax({ path: "../x" }) }, { name: "ok", data: "" }]))).toThrow();
    });

    test("end of archive and broken headers (tarfile.next semantics)", () => {
        // no end-of-archive blocks: fine
        expect(files(readTar(tar([{ name: "a", data: "1" }], false)))).toEqual([["a", "1"]]);
        // bad checksum: error on the first header, end of archive later
        expect(() => readTar(tar([{ name: "a", data: "1", corrupt: true }]))).toThrow();
        expect(files(readTar(tar([{ name: "a", data: "1" }, { name: "b", data: "2", corrupt: true }], false)))).toEqual([["a", "1"]]);
        // a broken header behind a long-name header is always an error
        expect(() => readTar(tar([{ name: "././@LongLink", type: "L", data: "x\0" }, { name: "b", data: "2", corrupt: true }]))).toThrow();
        expect(() => readTar(new Uint8Array(0))).toThrow();
        expect(readTar(new Uint8Array(1024))).toEqual([]);
        // truncated file data
        expect(() => readTar(tar([{ name: "a", data: "1", size: 4096 }], false))).toThrow();
    });
});

describe("gunzip", () => {
    const text = enc.encode("hello world ".repeat(100));

    test("single member", async () => {
        expect(await gunzip(gzipSync(text))).toEqual(text);
    });

    test("concatenated members and zero padding", async () => {
        const a = gzipSync(text.subarray(0, 500));
        const b = gzipSync(text.subarray(500));
        const joined = new Uint8Array([...a, 0, 0, ...b, 0, 0, 0, 0]);
        expect(await gunzip(joined)).toEqual(text);
        expect(await gunzip(new Uint8Array([...a, ...b]))).toEqual(text);
    });

    test("errors", async () => {
        await expect(gunzip(enc.encode("not gzip"))).rejects.toThrow();
        await expect(gunzip(new Uint8Array([...gzipSync(text), 1, 2, 3]))).rejects.toThrow();
        await expect(gunzip(gzipSync(text).subarray(0, 40))).rejects.toThrow();
        expect(await gunzip(new Uint8Array(0))).toEqual(new Uint8Array(0));
    });
});

test("sha256Hex", async () => {
    expect(await sha256Hex(enc.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

const BME = "/private/tmp/claude-502/-Users-fabian-rafreider-Documents-projekte-api-page--claude-worktrees-apps-artifacts/8c9bbec1-3602-4cf4-b69e-f9970acbdefb/scratchpad/dl/bme.tgz";

test.skipIf(!existsSync(BME))("real registry tarball (Adafruit BME280 Library 2.3.0)", async () => {
    const bytes = new Uint8Array(readFileSync(BME));
    expect(await sha256Hex(bytes)).toBe("cbaec8c604011e8d7951dcf9913289f6cb209aefd6542996d88e0190aef0ade1");
    const entries = readTar(await gunzip(bytes));
    expect(entries).toHaveLength(13);
    const props = entries.find((e) => e.path === "library.properties");
    expect(dec.decode(props!.data)).toContain("name=Adafruit BME280 Library\nversion=2.3.0\n");
    expect(entries.map((e) => e.path)).toContain("Adafruit_BME280.cpp");
});
