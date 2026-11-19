/**
 * Bundle blob ("AWB1", docs/pack-format.md): many small files in one download.
 *   "AWB1" | u32 LE json length | JSON [{p, n}] | data
 */
const MAGIC = [0x41, 0x57, 0x42, 0x31];

export interface BundleEntry {
    path: string;
    data: Uint8Array;
}

export function readBundle(bytes: Uint8Array): BundleEntry[] {
    if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not an AWB1 bundle");
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    const table = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as Array<{ p: string; n: number }>;
    const out: BundleEntry[] = [];
    let off = 8 + n;
    for (const e of table) {
        if (off + e.n > bytes.length) throw new Error("truncated AWB1 bundle");
        out.push({ path: e.p, data: bytes.subarray(off, off + e.n) });
        off += e.n;
    }
    return out;
}

export function writeBundle(entries: BundleEntry[]): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(entries.map((e) => ({ p: e.path, n: e.data.length }))));
    const total = 8 + json.length + entries.reduce((s, e) => s + e.data.length, 0);
    const out = new Uint8Array(total);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint32(4, json.length, true);
    out.set(json, 8);
    let off = 8 + json.length;
    for (const e of entries) {
        out.set(e.data, off);
        off += e.data.length;
    }
    return out;
}
