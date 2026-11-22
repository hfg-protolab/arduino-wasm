/**
 * The verification corpus: which sketches on which boards (Node/Bun only).
 *
 * - `arduino/…`  Arduino's built-in examples 01.Basics–04.Communication (vendored in
 *                test/corpus/examples/arduino, public domain / CC0) — every board; 09.USB
 *                (Keyboard/Mouse) only on boards with native USB (NATIVE_USB).
 * - `lib/…`      every example of every installed allowed library and its dependencies
 *                (.build/pack-work/libs/<dir>/<lib>/examples, installed by pack/build.ts):
 *                dir "all" → every board, dir "<arch>" → the boards of that arch.
 * - `esp32/…`    arduino-esp32's own examples of the ESP32, WiFi and Preferences libraries —
 *                ESP32 boards; the example's own CI marker decides per chip: `.skip.<chip>`
 *                (2.x), `ci.yml` (3.x: `targets: {<chip>: false}`, `requires` / `requires_any`
 *                against the chip's sdkconfig in framework-arduinoespressif32-libs).
 * - `esp8266/…`  the ESP8266 core's own examples (esp8266, ESP8266WiFi, EEPROM, Servo,
 *                Ticker) — ESP8266 boards.
 * - `broken/…`   deliberately broken sketches (test/corpus/broken.ts): diagnostics parity.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type BoardConfig, loadConfig, PKG, REPO } from "../../pack/common.ts";
import { frameworkPackage, libsRoot } from "../../pack/probe.ts";
import { BROKEN } from "./broken";
import { loadRegistryCorpus } from "./registry";

export interface CorpusSketch {
    id: string;
    files: Array<{ path: string; content: string }>;
    /** Boards this sketch applies to. */
    boards: string[];
    /** board → reason it is skipped up front (no build at all). */
    skip: Record<string, string>;
    /** Deliberately broken: the native and the wasm diagnostics must agree. */
    broken?: boolean;
    /** Registry sketches: `lib_deps` of platformio.ini (wasm: the file; pio: the env line). */
    libDeps?: string[];
}

/** PlatformIO boards whose MCU talks USB itself (Keyboard/Mouse/PluggableUSB): 09.USB runs there. */
const NATIVE_USB = new Set(["leonardo"]);

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
        if (skipFiles)
            for (const b of boards) {
                if (!b.chip || !on.includes(b.id)) continue;
                if (existsSync(join(dir, `.skip.${b.chip}`))) skip[b.id] = `example marked .skip.${b.chip}`;
                const why = existsSync(join(dir, "ci.yml")) ? ciYmlSkips(readFileSync(join(dir, "ci.yml"), "utf8"), b.chip) : null;
                if (why) skip[b.id] = `ci.yml: ${why}`;
            }
        out.push({ id, files: sketchSources(dir), boards: on, skip });
    };

    const arduino = join(REPO, "test/corpus/examples/arduino");
    for (const d of sketchDirs(arduino)) {
        const id = relative(arduino, d);
        add(`arduino/${id}`, d, ids((b) => !id.startsWith("09.USB/") || NATIVE_USB.has(b.board)));
    }

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

    const fw8266 = join(PKG, frameworkPackage("esp8266"), "libraries");
    for (const lib of ["esp8266", "ESP8266WiFi", "EEPROM", "Servo", "Ticker"]) {
        const ex = join(fw8266, lib, "examples");
        for (const d of sketchDirs(ex)) add(`esp8266/${lib}/${relative(ex, d)}`, d, ids((b) => b.arch === "esp8266"));
    }

    for (const b of BROKEN) out.push({ id: `broken/${b.id}`, files: b.files, boards: b.boards, skip: {}, broken: true });

    // registry libraries (test/corpus/registry.ts): opt-in, CORPUS_REGISTRY_TOP=<n> (examples per library: CORPUS_REGISTRY_EXAMPLES, default 3)
    const top = Number(process.env.CORPUS_REGISTRY_TOP ?? 0);
    if (top > 0) {
        const perLib = Number(process.env.CORPUS_REGISTRY_EXAMPLES ?? 3);
        const platformOf = (b: BoardConfig) => (b.arch === "avr" ? "atmelavr" : b.arch === "esp8266" ? "espressif8266" : "espressif32");
        for (const lib of loadRegistryCorpus().slice(0, top)) {
            const on = ids((b) => !lib.platforms.length || lib.platforms.includes("*") || lib.platforms.includes(platformOf(b)));
            for (const ex of lib.examples.slice(0, perLib)) out.push({ id: `reg/${lib.owner}/${lib.name}/${ex.id}`, files: ex.files, boards: on, skip: {}, libDeps: [`${lib.owner}/${lib.name}@${lib.version}`] });
        }
    }
    return out;
}

/** sdkconfig of a chip in Arduino-ESP32 3.x's prebuilt libraries: CONFIG_X=y lines. */
const sdkconfigs = new Map<string, Set<string>>();
function sdkconfig(chip: string): Set<string> {
    let s = sdkconfigs.get(chip);
    if (!s) {
        const p = join(PKG, "framework-arduinoespressif32-libs", chip, "sdkconfig");
        s = new Set(existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => /^CONFIG_\w+=/.test(l)).map((l) => l.trim()) : []);
        sdkconfigs.set(chip, s);
    }
    return s;
}

/**
 * arduino-esp32 3.x `ci.yml` of an example (its own CI's rules): why the chip is skipped, or null.
 * `targets: {<chip>: false}`; `requires:` all of, `requires_any:` one of the sdkconfig lines.
 * (`fqbn`/`fqbn_append` — e.g. a bigger partition — are not applied: such a sketch is compared
 * as pio builds it with the board's defaults, or skipped when that does not compile.)
 */
export function ciYmlSkips(text: string, chip: string): string | null {
    let section = "";
    const requires: string[] = [];
    const any: string[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.replace(/#.*$/, "").trimEnd();
        if (!line.trim()) continue;
        const top = /^(\w+):\s*(.*)$/.exec(line);
        if (top) {
            section = top[1]!;
            continue;
        }
        const t = /^\s+(\w+):\s*(\w+)\s*$/.exec(line);
        if (section === "targets" && t && t[1] === chip && t[2] === "false") return `targets.${chip}: false`;
        const item = /^\s*-\s*(\S+)\s*$/.exec(line);
        if (item && section === "requires") requires.push(item[1]!);
        if (item && section === "requires_any") any.push(item[1]!);
    }
    const cfg = sdkconfig(chip);
    if (!cfg.size) return null;
    // entries are regular expressions over the sdkconfig lines (CONFIG_CAMERA_TASK_STACK_SIZE=[0-9]+)
    const has = (r: string) => {
        const re = new RegExp(`^${r}$`);
        return [...cfg].some((l) => re.test(l));
    };
    const missing = requires.filter((r) => !has(r));
    if (missing.length) return `requires ${missing.join(", ")}`;
    if (any.length && !any.some(has)) return `requires one of ${any.join(", ")}`;
    return null;
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
