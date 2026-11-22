/** Pack format v1 (docs/pack-format.md): the types the runtime reads. */
import type { ElfToImageOptions } from "./esp-image";
import type { Esp8266ImageOptions } from "./esp8266-image";
import type { SizeLimits } from "./size";

export interface FileRef {
    /** Relative to the pack base URL: "files/<hash>.<ext>". */
    file: string;
    /** Raw size in bytes. */
    size: number;
    sha256: string;
}

export interface PackIndex {
    format: 1;
    packVersion: string;
    boards: Record<string, string>;
    licenses: string;
}

export type ToolName = "cc1plus" | "cc1" | "as" | "ld";

export interface ToolRef {
    js: FileRef;
    wasm: FileRef;
    /** argv[0] / Module.thisProgram (ld finds its default scripts relative to it). */
    thisProgram: string;
}

export interface LibraryEntry {
    name: string;
    version?: string;
    /** PlatformIO registry owner (`.piopm` of an installed package); absent for framework libraries. */
    owner?: string;
    /** "registry": fetched at compile time from a project's `lib_deps` (never in a pack). */
    origin: "framework" | "allowed" | "registry";
    includeDirs: string[];
    headers: string[];
    deps: string[];
    archive?: { path: string } & FileRef;
    /**
     * Library objects linked one by one (pioarduino: `lib_archive = no`), in pio's order; they
     * come before the sketch objects in `${OBJS}`.
     */
    objects?: Array<{ path: string } & FileRef>;
    /**
     * What PlatformIO's chain LDF reads of the library (ldf.ts): its directory (virtual), every
     * header/source file in it with the file's `#include`s in SCons' order (`<name` / `"name`),
     * the source files its src_filter selects, and its place in PlatformIO's library-builder list.
     */
    scan?: {
        root: string;
        files: Record<string, string[]>;
        sources: string[];
        order: number;
        /** library.json `build.libLDFMode` (registry libraries; default: the project's chain). */
        ldfMode?: string;
        /** library.json `dependencies` (PlatformIO builders only: Arduino builders leave them to the LDF). */
        dependencies?: Array<{ owner?: string; name: string; version?: string }>;
        /** Include dirs as absolute virtual paths when `includeDirs` are project-relative (registry libraries). */
        absIncludeDirs?: string[];
        /** Package name as the package manager recorded it (lib_deps matching). */
        pkgName?: string;
    };
}

export interface BoardManifest {
    format: 1;
    packVersion: string;
    id: string;
    name: string;
    arch: "avr" | "esp32" | "esp8266";
    chip?: "esp32" | "esp32s3" | "esp32c3" | "esp32c6" | "esp8266";
    platform: string;
    board: string;
    framework: string;
    env: string;
    tools: Record<ToolName, ToolRef>;
    fs: { cwd: string; srcDir: string; buildDir: string; mkdirs: string[] };
    headers: FileRef[];
    compile: {
        cpp: { cc1plus: string[]; as: string[] };
        c: { cc1: string[]; as: string[] };
    };
    pch?: { gch: FileRef; path: string; header: string; args: string[] };
    /** SOURCE_DATE_EPOCH of the pack's native builds (core, reference builds): the compilers get it too (__DATE__/__TIME__). */
    sourceDateEpoch?: number;
    /**
     * Assembler sources of libraries built at compile time: `.S`/`.sx`/`.spp` go through the C
     * preprocessor (`cc1 -E -lang-asm`, then `as`), `.s` straight to `as` — the native driver's
     * `-###` of PlatformIO's own command lines. `${LIBINC}` / `${SRC}` / `${OBJ}` / `${ASM}` like `compile`.
     */
    compileAsm?: { S: { cc1: string[]; as: string[] }; s: { as: string[] } };
    /**
     * What resolving and building PlatformIO registry libraries (`lib_deps`) needs. Library
     * compile lines are `compile.*` without the project's own `-I src`.
     */
    registry?: {
        /** PlatformIO platform name (atmelavr, espressif32, espressif8266): registry compatibility. */
        platform: string;
        framework: string;
        /** PlatformIO's `lib_archive` of the board (false on pioarduino: objects are linked one by one). */
        libArchive: boolean;
        /** Library names of every installed framework (PlatformIO's `is_builtin_lib`): owner-less dependencies of these are not installed. */
        builtinNames: string[];
        /** `.pio/libdeps/<env>` relative to `fs.cwd`. */
        libdepsDir: string;
    };
    /**
     * Every header under the framework's include directories, one content-addressed file each
     * (`files/<sha>.h`), for headers the closure bundle lacks: JSON `HeaderIndex`.
     */
    headerIndex?: FileRef;
    libraries: LibraryEntry[];
    link: {
        ld: string[];
        files: Array<{ path: string } & FileRef>;
        lazy?: { index: FileRef; base: FileRef };
    };
    output:
        | { kind: "hex"; remove: string[] }
        | { kind: "esp-image"; image: ElfToImageOptions; appAddress: number; images: Array<{ name: string; address: number } & FileRef> }
        /** ESP8266: elf2bin.py (eboot + app) → one firmware.bin at `appAddress` (0x0). */
        | { kind: "esp8266-image"; image: Esp8266ImageOptions; eboot: FileRef; appAddress: number };
    size: SizeLimits;
    stats: Record<string, { raw: number; brotli: number }>;
}

/** `headerIndex`: include roots (virtual, in search order) and their files. */
export interface HeaderIndex {
    dirs: string[];
    /** [dir index, path relative to the dir, sha256 (first 32 hex = file name), size] */
    files: Array<[number, string, string, number]>;
}

/** Lazy-link index (ESP32). Symbols are indices into `strings`. */
export interface LinkIndex {
    strings: string[];
    inputs: Array<
        | { kind: "objects" }
        | { kind: "libs" }
        | { kind: "object"; path: string; syms: IndexSyms }
        | { kind: "archive"; archive: number }
        | { kind: "groupStart" }
        | { kind: "groupEnd" }
    >;
    roots: string[];
    wraps: string[];
    archives: Array<{ path: string; members: IndexMember[] }>;
}

export interface IndexSyms {
    d?: number[];
    w?: number[];
    c?: number[];
    u?: number[];
    uw?: number[];
}

export interface IndexMember extends IndexSyms {
    n: string;
    h: string;
    s: number;
    /** armap symbols of the member, in armap order */
    a?: number[];
}
