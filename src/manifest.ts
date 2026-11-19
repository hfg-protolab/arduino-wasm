/** Pack format v1 (docs/pack-format.md): the types the runtime reads. */
import type { ElfToImageOptions } from "./esp-image";
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
}

export interface BoardManifest {
    format: 1;
    packVersion: string;
    id: string;
    name: string;
    arch: "avr" | "esp32";
    chip?: "esp32" | "esp32s3" | "esp32c3";
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
        | { kind: "esp-image"; image: ElfToImageOptions; appAddress: number; images: Array<{ name: string; address: number } & FileRef> };
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
