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
    origin: "framework" | "allowed";
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
    scan?: { root: string; files: Record<string, string[]>; sources: string[]; order: number };
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
