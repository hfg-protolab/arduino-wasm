/**
 * The verification corpus: which sketches on which boards (Node/Bun only).
 *
 * - `arduino/…`  Arduino's built-in examples 01.Basics–04.Communication (vendored in
 *                test/corpus/examples/arduino, public domain / CC0) — every board.
 * - `lib/…`      every example of every installed allowed library and its dependencies
 *                (.build/pack-work/libs/<dir>/<lib>/examples, installed by pack/build.ts):
 *                dir "all" → every board, dir "<arch>" → the boards of that arch.
 * - `esp32/…`    arduino-esp32's own examples of the ESP32, WiFi and Preferences libraries —
 *                ESP32 boards; a `.skip.<chip>` file in the example skips that chip (the
 *                example's own CI marker).
 * - `broken/…`   deliberately broken sketches (test/corpus/broken.ts): diagnostics parity.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type BoardConfig, loadConfig, PKG, REPO } from "../../pack/common.ts";
import { frameworkPackage, libsRoot } from "../../pack/probe.ts";
import { BROKEN } from "./broken";

export interface CorpusSketch {
    id: string;
    files: Array<{ path: string; content: string }>;
    /** Boards this sketch applies to. */
    boards: string[];
    /** board → reason it is skipped up front (no build at all). */
    skip: Record<string, string>;
    /** Deliberately broken: the native and the wasm diagnostics must agree. */
    broken?: boolean;
}

const SRC_RE = /\.(ino|pde|cpp|c|h|hpp)$/;

/** Every sketch directory below `root`: a directory D with D/<basename(D)>.ino or .pde. */
function sketchDirs(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
        const name = basename(d);
        const entries = readdirSync(d).sort();
        if (entries.includes(`${name}.ino`) || entries.includes(`${name}.pde`)) out.push(d);
        for (const e of entries) if (statSync(join(d, e)).isDirectory() && !e.startsWith(".")) walk(join(d, e));
    };
    walk(root);
    return out;
}

/** The source files of a sketch dir (recursively, but not into nested sketches), relative paths. */
function sketchSources(dir: string): Array<{ path: string; content: string }> {
    const out: Array<{ path: string; content: string }> = [];
    const walk = (d: string, top: boolean) => {
        const entries = readdirSync(d).sort();
        const name = basename(d);
        if (!top && (entries.includes(`${name}.ino`) || entries.includes(`${name}.pde`))) return;
        for (const e of entries) {
            const p = join(d, e);
            if (statSync(p).isDirectory()) {
                if (!e.startsWith(".")) walk(p, false);
            } else if (SRC_RE.test(e)) out.push({ path: relative(dir, p), content: readFileSync(p, "utf8") });
        }
    };
    walk(dir, true);
    return out;
}

export function loadCorpus(): CorpusSketch[] {
    const cfg = loadConfig();
    const boards = cfg.boards;
    const ids = (pred: (b: BoardConfig) => boolean) => boards.filter(pred).map((b) => b.id);
    const out: CorpusSketch[] = [];
    const add = (id: string, dir: string, on: string[], skipFiles = false) => {
        const skip: Record<string, string> = {};
        if (skipFiles) for (const b of boards) if (b.chip && existsSync(join(dir, `.skip.${b.chip}`))) skip[b.id] = `example marked .skip.${b.chip}`;
        out.push({ id, files: sketchSources(dir), boards: on, skip });
    };

    const arduino = join(REPO, "test/corpus/examples/arduino");
    for (const d of sketchDirs(arduino)) add(`arduino/${relative(arduino, d)}`, d, ids(() => true));

    for (const dirName of ["all", ...new Set(boards.map((b) => b.arch))]) {
        const root = join(libsRoot(), dirName);
        if (!existsSync(root)) continue;
        for (const lib of readdirSync(root).sort()) {
            const ex = join(root, lib, "examples");
            for (const d of sketchDirs(ex)) add(`lib/${lib}/${relative(ex, d)}`, d, ids((b) => dirName === "all" || b.arch === dirName));
        }
    }

    const fw = join(PKG, frameworkPackage("esp32"), "libraries");
    for (const lib of ["ESP32", "WiFi", "Preferences"]) {
        const ex = join(fw, lib, "examples");
        for (const d of sketchDirs(ex)) add(`esp32/${lib}/${relative(ex, d)}`, d, ids((b) => b.arch === "esp32"), true);
    }

    for (const b of BROKEN) out.push({ id: `broken/${b.id}`, files: b.files, boards: b.boards, skip: {}, broken: true });
    return out;
}

/** `--sketch` filter: comma-separated substrings of the id; `*` is a wildcard. */
export function matchSketch(id: string, filter: string | undefined): boolean {
    if (!filter) return true;
    return filter.split(",").some((f) => {
        if (!f.includes("*")) return id.includes(f);
        const re = new RegExp(`^${f.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        return re.test(id);
    });
}
