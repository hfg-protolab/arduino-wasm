import { expect, test } from "bun:test";
import { readBundle, writeBundle } from "./bundle";

test("AWB1 bundle round trip", () => {
    const enc = new TextEncoder();
    const entries = [
        { path: "/opt/pio/packages/a.h", data: enc.encode("#pragma once\n") },
        { path: "/opt/pio-libs/all/Lib Name/ü.h", data: new Uint8Array(0) },
        { path: "deadbeef", data: new Uint8Array([0, 1, 2, 255]) },
    ];
    const back = readBundle(writeBundle(entries));
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    expect(back.map((e) => [...e.data])).toEqual(entries.map((e) => [...e.data]));
    expect(() => readBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
});
