import { describe, expect, test } from "bun:test";
import { PackStore } from "./cache";

/** A fetch whose body arrives in chunks released by hand. */
function gatedFetch(chunks: Uint8Array[]) {
    let release!: () => void;
    let next = 0;
    const waiters: Array<() => void> = [];
    const fetch = async () =>
        new Response(
            new ReadableStream<Uint8Array>({
                async pull(ctrl) {
                    if (next >= chunks.length) return ctrl.close();
                    await new Promise<void>((r) => waiters.push(r));
                    ctrl.enqueue(chunks[next++]!);
                },
            }),
            { headers: { "content-type": "application/octet-stream" } },
        );
    release = () => waiters.shift()?.();
    return { fetch, step: async () => { release(); await new Promise((r) => setTimeout(r, 5)); } };
}

describe("PackStore progress", () => {
    test("a caller that joins a download in flight hears the bytes so far, then the rest", async () => {
        const g = gatedFetch([new Uint8Array(30), new Uint8Array(70)]);
        const store = new PackStore("http://pack.test/", { fetch: g.fetch, cacheStorage: false });
        const ref = { file: "files/a.bin", size: 100, sha256: "a".repeat(64) };

        const first: number[] = [];
        const p = store.get(ref, (n) => first.push(n)); // e.g. the prewarm
        await new Promise((r) => setTimeout(r, 5));
        await g.step(); // 30 bytes arrive
        expect(store.has(ref)).toBe(false);

        const late: number[] = [];
        store.watch(ref, (n) => late.push(n)); // the compile that clicked during the download
        expect(late).toEqual([30]);

        await g.step(); // 70 more
        await g.step(); // end of stream
        await p;
        expect(first.reduce((a, b) => a + b, 0)).toBe(100);
        expect(late.reduce((a, b) => a + b, 0)).toBe(100);
        expect(store.has(ref)).toBe(true);

        const after: number[] = [];
        store.watch(ref, (n) => after.push(n));
        expect(after).toEqual([]);
    });
});
