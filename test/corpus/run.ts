/**
 * Verification corpus (phase 4): every corpus sketch (test/corpus/corpus.ts) × every applicable
 * board, compiled with compileFirmware (packs from disk) and checked against
 *
 *  1. a native `ld` over the same stripped pack files (test/native-link.ts): byte-identical ELF
 *     (ESP32: up to the path of ld's own crtbegin/crtend file symbols) and app image;
 *  2. `pio run` (cached, test/corpus/reference.ts): AVR .hex identical; ESP32 app image identical
 *     outside the masked fields (ELF SHA-256 at 0xb0..0xd0, checksum byte, appended digest) —
 *     differences inside .eh_frame (--strip-debug drops what dead FDEs of discarded COMDAT
 *     copies point at, spike/link/FINDINGS.md pitfall 1) are recorded, any other difference
 *     fails; bootloader/partitions identical;
 *  3. broken sketches: the same errors (file/line/column/message) as gcc/ld natively;
 *  4. the size report equals pio's "RAM:"/"Flash:" numbers.
 *
 * Sketches that do not compile natively are skipped; sketches that compile natively but include
 * a header the pack's header bundle lacks are reported separately ("header-gap").
 *
 *   bun run test:corpus [--board uno,esp32dev] [--sketch Blink,lib/Adafruit*] [--slots 2]
 *                       [--jobs 6] [--force-ref] [--list] [--pack <dir>]
 *
 * One child process per board (wasm compiles are CPU-bound in-process; pio runs alongside).
 * Results: .build/corpus/results.json.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, REPO } from "../../pack/common.ts";
import { compileFirmware, type CompileResult } from "../../src/compile";
import { ElfFile } from "../../src/elf";
import { elfToEspImage } from "../../src/esp-image";
import type { BoardManifest } from "../../src/manifest";
import type { Diagnostic } from "../../src/types";
import { diskFetch, PACK_BASE } from "../node-fetch";
import { compareWithNative, diffCount, nativeLink } from "../native-link";
import { type CorpusSketch, loadCorpus, matchSketch } from "./corpus";
import { type NativeRef, RefBuilder } from "./reference";

type Status = "pass" | "fail" | "skipped" | "header-gap";

export interface CaseResult {
    sketch: string;
    board: string;
    status: Status;
    reason?: string;
    /** Headers the wasm compile could not find although the native build could. */
    missingHeaders?: string[];
    /** Known, tolerated differences against pio (bytes in .eh_frame). */
    ehFrameBytes?: number;
    /** Compared against a pio build with __FILE__ of the sketch mapped to /work/project. */
    fileMap?: boolean;
    /** Natively failing sketches: did the wasm diagnostics equal the native ones? */
    diagnosticsMatch?: boolean;
    wasmSeconds?: number;
    refSeconds?: number;
    refCached?: boolean;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const cfg = loadConfig();
const PACK = opt("pack") ?? process.env.PACK ?? join(REPO, ".build/packs", cfg.packVersion);
const OUT = resolve(process.env.CORPUS_OUT ?? join(REPO, ".build/corpus"));

const fmtDiag = (d: Diagnostic) => `${d.file ?? "-"}:${d.line ?? "-"}:${d.column ?? "-"}: ${d.message}`;
const MISSING_RE = /^(.+): No such file or directory$/;

/** ESP image segments: offset in the image → load address. */
function imageSegments(app: Uint8Array): Array<{ addr: number; off: number; len: number }> {
    const dv = new DataView(app.buffer, app.byteOffset, app.byteLength);
    const out: Array<{ addr: number; off: number; len: number }> = [];
    let off = 24;
    for (let i = 0; i < app[1]!; i++) {
        const addr = dv.getUint32(off, true);
        const len = dv.getUint32(off + 4, true);
        out.push({ addr, off: off + 8, len });
        off += 8 + len;
    }
    return out;
}

/**
 * Differences between two ESP32 app images outside the masked fields, by where they land:
 * "eh_frame" ([__eh_frame, __init_array_start) of the ELF) is the known --strip-debug effect,
 * anything else is a real difference (named after the ELF section).
 */
export function classifyImageDiff(app: Uint8Array, ref: Uint8Array, elf: ElfFile): { ehFrame: number; other: Map<string, number> } {
    const n = app.length;
    const masked = (i: number) => (i >= 0xb0 && i < 0xd0) || i >= n - 33;
    const segs = imageSegments(app);
    const eh0 = elf.symbol("__eh_frame")?.value;
    const eh1 = elf.symbol("__init_array_start")?.value;
    let ehFrame = 0;
    const other = new Map<string, number>();
    for (let i = 0; i < Math.min(n, ref.length); i++) {
        if (app[i] === ref[i] || masked(i)) continue;
        const s = segs.find((x) => i >= x.off && i < x.off + x.len);
        const va = s ? s.addr + (i - s.off) : -1;
        if (eh0 !== undefined && eh1 !== undefined && va >= eh0 && va < eh1) ehFrame++;
        else {
            const sec = s ? (elf.sections.find((x) => x.size && va >= x.addr && va < x.addr + x.size)?.name ?? `0x${va.toString(16)}`) : "image header";
            other.set(sec, (other.get(sec) ?? 0) + 1);
        }
    }
    if (app.length !== ref.length) other.set("length", Math.abs(app.length - ref.length));
    return { ehFrame, other };
}

async function runCase(s: CorpusSketch, board: string, m: BoardManifest, refs: RefBuilder): Promise<CaseResult> {
    const base = { sketch: s.id, board };
    if (s.skip[board]) return { ...base, status: "skipped", reason: s.skip[board] };
    const refP = refs.build(s.id, s.files, flag("force-ref"));
    const t = performance.now();
    const r = await compileFirmware({ board, files: s.files }, { packBaseUrl: PACK_BASE, fetch: diskFetch(PACK), keepIntermediates: true, cacheStorage: false });
    const wasmSeconds = Math.round((performance.now() - t) / 100) / 10;
    const ref = await refP;
    const timing = { wasmSeconds, refSeconds: ref.seconds, refCached: ref.cached };
    const res = (status: Status, reason?: string, extra: Partial<CaseResult> = {}): CaseResult => ({ ...base, status, ...(reason ? { reason } : {}), ...timing, ...extra });

    const wasmErr = r.errors.map(fmtDiag);
    const nativeErr = ref.errors.map(fmtDiag);
    // as sets: pio compiles translation units in parallel, so errors of different files come in any order
    const sameDiag = JSON.stringify([...wasmErr].sort()) === JSON.stringify([...nativeErr].sort());
    const diagDiff = () => `native:\n    ${nativeErr.join("\n    ") || "(none)"}\n  wasm:\n    ${wasmErr.join("\n    ") || "(none)"}`;

    if (s.broken) {
        if (ref.ok) return res("fail", "broken sketch compiled natively");
        if (r.ok) return res("fail", `wasm compiled a sketch pio rejects:\n  ${nativeErr.join("\n  ")}`);
        if (!nativeErr.length) return res("fail", `no native errors parsed:\n${ref.logTail?.slice(-1500)}`);
        return sameDiag ? res("pass") : res("fail", `diagnostics differ\n  ${diagDiff()}`);
    }
    if (!ref.ok) {
        const first = nativeErr[0] ?? ref.logTail?.trim().split("\n").slice(-3).join(" | ") ?? "?";
        if (r.ok) return res("fail", `wasm compiles, pio does not: ${first}`);
        return res("skipped", `does not compile natively: ${first}`, { diagnosticsMatch: sameDiag });
    }
    if (!r.ok) {
        const missing = r.errors.map((e) => MISSING_RE.exec(e.message)?.[1]).filter((x): x is string => !!x);
        if (missing.length) return res("header-gap", `missing in the header bundle: ${missing.join(", ")}`, { missingHeaders: missing });
        return res("fail", `wasm failed, pio ok:\n  ${wasmErr.slice(0, 8).join("\n  ")}\n${r.log.slice(-1500)}`);
    }

    const problems: string[] = [];
    // 1. native ld over the same stripped pack files
    const elfPath = `${m.fs.cwd}/${m.fs.buildDir}/firmware.elf`;
    const elf = r.intermediates!.get(elfPath)!;
    const objs = [...r.intermediates!.keys()].filter((p) => p.endsWith(".o")).map((p) => p.slice(m.fs.cwd.length + 1)).sort();
    // the wasm link's library order (LDF post-order)
    const libs = r.stats!.libraries.map((n) => m.libraries.find((l) => l.name === n)!).filter((l) => l.archive).map((l) => l.archive!.path);
    let native;
    try {
        native = nativeLink(PACK, m, r.intermediates!, objs, libs, join(OUT, "work"));
        const why = compareWithNative(m, elf, native);
        if (why) problems.push(`native link: ${why}`);
    } catch (e) {
        problems.push(`native link: ${(e as Error).message.slice(0, 1500)}`);
    }

    if (m.output.kind === "esp-image" && native) {
        const app = r.files.find((f) => f.name === "firmware.bin")!.data;
        const nativeApp = await elfToEspImage(native.elf, m.output.image);
        const n = nativeApp.length;
        const d = diffCount(app, nativeApp, (i) => (i >= 0xb0 && i < 0xd0) || i >= n - 33);
        if (d) problems.push(`app image: ${d} bytes differ from the native link's image`);
    }

    // 2. + 4. pio: images and size report
    let vs = comparePio(r, m, elf, ref);
    let fileMap = false;
    if (vs.problems.length && vs.embedsProjectPath && m.arch === "esp32") {
        // the sketch expands __FILE__ (log_e, assert): compare with a reference whose __FILE__
        // names /work/project like the pack's virtual project dir
        const mapped = await refs.build(s.id, s.files, flag("force-ref"), "file-map");
        if (mapped.ok) {
            vs = comparePio(r, m, elf, mapped);
            fileMap = true;
        }
    }
    problems.push(...vs.problems);
    const extra: Partial<CaseResult> = { ...(vs.ehFrameBytes ? { ehFrameBytes: vs.ehFrameBytes } : {}), ...(fileMap ? { fileMap: true } : {}) };
    return problems.length ? res("fail", problems.join("\n  "), extra) : res("pass", undefined, extra);
}

/** A pio image holding this embedded a reference project's path (__FILE__). */
const PROJECT_PATH_BYTES = new TextEncoder().encode("/corpus-proj/");
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

/** pio's images and size report vs the wasm build. */
function comparePio(r: CompileResult, m: BoardManifest, elf: Uint8Array, ref: NativeRef): { problems: string[]; ehFrameBytes?: number; embedsProjectPath: boolean } {
    const problems: string[] = [];
    let ehFrameBytes: number | undefined;
    let pioImage: Uint8Array;
    if (m.output.kind === "hex") {
        const hex = new TextDecoder().decode(r.files.find((f) => f.name === "firmware.hex")!.data);
        const pioHex = readFileSync(join(ref.dir, "firmware.hex"), "utf8");
        pioImage = new TextEncoder().encode(pioHex);
        if (hex !== pioHex) problems.push("firmware.hex differs from pio");
    } else {
        const app = r.files.find((f) => f.name === "firmware.bin")!.data;
        pioImage = new Uint8Array(readFileSync(join(ref.dir, "firmware.bin")));
        const c = classifyImageDiff(app, pioImage, new ElfFile(elf));
        if (c.other.size) problems.push(`app image vs pio: ${[...c.other].map(([k, v]) => `${v} B in ${k}`).join(", ")}${c.ehFrame ? ` (+${c.ehFrame} B in .eh_frame)` : ""}`);
        if (c.ehFrame) ehFrameBytes = c.ehFrame;
        for (const f of ["bootloader.bin", "partitions.bin"]) {
            if (diffCount(r.files.find((x) => x.name === f)!.data, new Uint8Array(readFileSync(join(ref.dir, f))))) problems.push(`${f} differs from pio`);
        }
    }
    const ws = r.size!;
    if (!ref.size) problems.push("no size report in the pio log");
    else if (ws.flash !== ref.size.flash || ws.ram !== ref.size.ram || ws.flashMax !== ref.size.flashMax || ws.ramMax !== ref.size.ramMax) {
        problems.push(`size: wasm flash ${ws.flash}/${ws.flashMax} ram ${ws.ram}/${ws.ramMax}, pio flash ${ref.size.flash}/${ref.size.flashMax} ram ${ref.size.ram}/${ref.size.ramMax}`);
    }
    // (an Intel HEX holds the bytes as hex text: the path would not show; AVR has no -fmacro-prefix-map anyway)
    return { problems, ehFrameBytes, embedsProjectPath: problems.length > 0 && contains(pioImage, PROJECT_PATH_BYTES) };
}

// ---------------------------------------------------------------- child: one board

async function child(board: string) {
    const mPath = join(PACK, "boards", `${board}.json`);
    const corpus = loadCorpus().filter((s) => s.boards.includes(board) && matchSketch(s.id, opt("sketch")));
    const emit = (r: CaseResult) => process.stdout.write(`@@${JSON.stringify(r)}\n`);
    if (!existsSync(mPath)) {
        for (const s of corpus) emit({ sketch: s.id, board, status: "skipped", reason: "board missing from the pack" });
        return;
    }
    const m = JSON.parse(readFileSync(mPath, "utf8")) as BoardManifest;
    const refs = new RefBuilder(board, Number(opt("slots") ?? 1));
    // queue the reference builds ahead (they run in pio processes while we compile)
    for (const s of corpus) if (!s.skip[board]) void refs.build(s.id, s.files, flag("force-ref")).catch(() => {});
    let i = 0;
    for (const s of corpus) {
        let r: CaseResult;
        try {
            r = await runCase(s, board, m, refs);
        } catch (e) {
            r = { sketch: s.id, board, status: "fail", reason: `exception: ${(e as Error).stack?.slice(0, 1500)}` };
        }
        emit(r);
        process.stderr.write(`[${board}] ${++i}/${corpus.length} ${r.status.padEnd(10)} ${s.id}${r.status === "fail" ? `\n  ${r.reason}` : ""}\n`);
    }
}

// ---------------------------------------------------------------- main

function table(results: CaseResult[], boards: string[]): string {
    const rows = boards.map((b) => {
        const rs = results.filter((r) => r.board === b);
        const n = (s: Status) => rs.filter((r) => r.status === s).length;
        const eh = rs.filter((r) => r.ehFrameBytes).length;
        return `| ${b} | ${rs.length} | ${n("pass")} | ${n("fail")} | ${n("skipped")} | ${n("header-gap")} | ${eh} |`;
    });
    const tot = (s: Status) => results.filter((r) => r.status === s).length;
    return [
        "| board | cases | pass | fail | skipped | header-gap | pass with .eh_frame diff |",
        "|---|---|---|---|---|---|---|",
        ...rows,
        `| **all** | ${results.length} | ${tot("pass")} | ${tot("fail")} | ${tot("skipped")} | ${tot("header-gap")} | ${results.filter((r) => r.ehFrameBytes).length} |`,
    ].join("\n");
}

async function main() {
    const t0 = Date.now();
    const all = loadCorpus();
    const boards = (opt("board")?.split(",") ?? cfg.boards.map((b) => b.id)).filter((b) => cfg.boards.some((x) => x.id === b));
    if (flag("list")) {
        for (const s of all.filter((x) => matchSketch(x.id, opt("sketch")))) console.log(`${s.id}  [${s.boards.filter((b) => boards.includes(b)).join(", ")}]`);
        return;
    }
    const jobs = Number(opt("jobs") ?? boards.length);
    const results: CaseResult[] = [];
    const passArgs = args.filter((_, i) => !["--board", "--jobs"].includes(args[i]!) && !["--board", "--jobs"].includes(args[i - 1]!));
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(jobs, boards.length) }, async () => {
            while (next < boards.length) {
                const b = boards[next++]!;
                await new Promise<void>((res) => {
                    const p = spawn(process.execPath, [import.meta.path, "--child", b, ...passArgs], { stdio: ["ignore", "pipe", "inherit"] });
                    let buf = "";
                    p.stdout.on("data", (d: Buffer) => {
                        buf += d.toString();
                        let k: number;
                        while ((k = buf.indexOf("\n")) >= 0) {
                            const line = buf.slice(0, k);
                            buf = buf.slice(k + 1);
                            if (line.startsWith("@@")) results.push(JSON.parse(line.slice(2)));
                            else if (line.trim()) process.stderr.write(`[${b}] ${line}\n`);
                        }
                    });
                    p.on("close", (code) => {
                        if (code) results.push({ sketch: "(board run)", board: b, status: "fail", reason: `child exited with ${code}` });
                        res();
                    });
                });
            }
        }),
    );
    const seconds = Math.round((Date.now() - t0) / 1000);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "results.json"), JSON.stringify({ packVersion: cfg.packVersion, seconds, results }, null, 1));

    const order = (r: CaseResult) => `${r.board}|${r.sketch}`;
    results.sort((a, b) => (order(a) < order(b) ? -1 : 1));
    const fails = results.filter((r) => r.status === "fail");
    const gaps = results.filter((r) => r.status === "header-gap");
    const out: string[] = ["", table(results, boards), ""];
    if (fails.length) out.push("Failures:", ...fails.map((r) => `- ${r.board} ${r.sketch}: ${r.reason}`), "");
    if (gaps.length) {
        const byHeader = new Map<string, string[]>();
        for (const r of gaps) for (const h of r.missingHeaders ?? []) byHeader.set(h, [...(byHeader.get(h) ?? []), `${r.sketch}@${r.board}`]);
        out.push("Header-bundle gaps (compile natively, header missing from the pack):", ...[...byHeader].map(([h, v]) => `- ${h}: ${v.join(", ")}`), "");
    }
    const mism = results.filter((r) => r.diagnosticsMatch === false);
    if (mism.length) out.push(`Skipped sketches whose wasm diagnostics differ from the native ones (${mism.length}):`, ...mism.map((r) => `- ${r.board} ${r.sketch}`), "");
    const fm = results.filter((r) => r.fileMap);
    if (fm.length) out.push(`Compared with __FILE__ of the sketch mapped to /work/project (the sketch expands __FILE__): ${fm.map((r) => `${r.sketch}@${r.board}`).join(", ")}`, "");
    const eh = results.filter((r) => r.ehFrameBytes);
    if (eh.length) out.push(`Known .eh_frame differences vs pio (tolerated): ${eh.map((r) => `${r.sketch}@${r.board} (${r.ehFrameBytes} B)`).join(", ")}`, "");
    out.push(`${results.length} cases in ${Math.floor(seconds / 60)} min ${seconds % 60} s (results: ${join(OUT, "results.json")})`);
    console.log(out.join("\n"));
    process.exit(fails.length ? 1 : 0);
}

if (import.meta.main) {
    const ci = args.indexOf("--child");
    if (ci >= 0) await child(args[ci + 1]!);
    else await main();
}
