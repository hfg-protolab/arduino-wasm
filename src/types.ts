/**
 * Public types of the package. Self-contained on purpose (no host/app SDK imports): a host maps
 * these to its own wire format.
 */

/** The boards of the default pack configuration (PlatformIO board in brackets). */
export type KnownBoard =
    | "uno" // atmelavr: uno
    | "nano" // atmelavr: nanoatmega328new
    | "nano-old" // atmelavr: nanoatmega328
    | "esp32dev" // espressif32: esp32dev
    | "esp32-s3" // espressif32: esp32-s3-devkitc-1
    | "esp32-c3"; // espressif32: esp32-c3-devkitm-1

/** A board id of the pack (`boards/<id>.json`); packs are configuration, so any string. */
export type Board = KnownBoard | (string & {});

export interface SourceFile {
    /** Relative to the project's `src/` (a leading `src/` is dropped). `.ino`/`.pde`/`.cpp`/`.c`/`.h`. */
    path: string;
    content: string;
}

export interface CompileRequest {
    board: Board;
    files: SourceFile[];
}

/** One gcc/ld message, located in the caller's files where possible. */
export interface Diagnostic {
    file: string | null;
    line: number | null;
    column: number | null;
    message: string;
}

/** Program/data size as PlatformIO reports it after linking ("RAM:" / "Flash:"). */
export interface FirmwareSize {
    flash: number;
    flashMax: number;
    ram: number;
    ramMax: number;
}

export interface FirmwareImage {
    /** e.g. "firmware.hex", "firmware.bin", "bootloader.bin". */
    name: string;
    /** Flash offset (ESP32 images); absent for Intel HEX, which carries its own addresses. */
    address?: number;
    data: Uint8Array;
}

export interface CompileResponse {
    ok: boolean;
    board: Board;
    errors: Diagnostic[];
    warnings: Diagnostic[];
    size?: FirmwareSize;
    files: FirmwareImage[];
    /** Compiler/linker output, like a build log. */
    log: string;
    durationMs: number;
    /** Where the time went and what was downloaded (diagnostics, benchmarks). */
    stats?: CompileStats;
}

export interface CompileStats {
    /** Bytes fetched over the network for this compile (0 when everything came from a cache). */
    downloadedBytes: number;
    /** Wall time per phase in ms. */
    phases: Partial<Record<"download" | "compile" | "link" | "resolve" | "post", number>>;
    /** Translation units compiled vs. served from the object cache. */
    compiled: number;
    cached: number;
    /** Lazy linking: archive members linked / fetched individually. */
    members?: { linked: number; fetched: number };
    libraries: string[];
}

export type CompilePhase = "download" | "compile" | "link" | "done";

export interface CompileProgress {
    phase: CompilePhase;
    /** Bytes (download) or steps (compile/link) done and expected. */
    loaded: number;
    total: number;
}
