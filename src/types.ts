/**
 * Public types of the package. Self-contained on purpose (no host/app SDK imports): a host maps
 * these to its own wire format.
 */

/** The boards of the default pack configuration (PlatformIO board in brackets). */
export type KnownBoard =
    | "uno" // atmelavr: uno
    | "nano" // atmelavr: nanoatmega328new
    | "nano-old" // atmelavr: nanoatmega328
    | "mega" // atmelavr: megaatmega2560
    | "leonardo" // atmelavr: leonardo
    | "esp32dev" // pioarduino espressif32: esp32dev
    | "esp32-s3" // pioarduino espressif32: esp32-s3-devkitc-1
    | "esp32-c3" // pioarduino espressif32: esp32-c3-devkitm-1
    | "esp32-c6" // pioarduino espressif32: esp32-c6-devkitc-1
    | "nano-esp32" // pioarduino espressif32: arduino_nano_esp32
    | "nodemcu" // espressif8266: nodemcuv2
    | "d1-mini"; // espressif8266: d1_mini

/** A board id of the pack (`boards/<id>.json`); packs are configuration, so any string. */
export type Board = KnownBoard | (string & {});

export interface SourceFile {
    /**
     * Relative to the project's `src/` (a leading `src/` is dropped). `.ino`/`.pde`/`.cpp`/`.c`/`.h`,
     * plus `platformio.ini` at the top: its `lib_deps` (PlatformIO registry libraries) and
     * `build_flags` (`[env]` + the first `[env:*]`).
     */
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
    /** A library problem that is not the sketch's code (lib_deps / registry); also an error with `file: null`. */
    problem?: LibraryProblem;
    /**
     * Headers no library of the pack or of lib_deps provides (the compiler's "No such file or
     * directory"), with registry libraries that ship them (framework arduino, the board's platform).
     */
    missingHeaders?: MissingHeader[];
}

export type LibraryProblem =
    | { kind: "libNotFound"; spec: string }
    | { kind: "libVersion"; spec: string; available: string[] }
    | { kind: "libIncompatible"; spec: string; platform: string }
    | { kind: "libUnsupported"; spec: string; reason: string }
    | { kind: "registryUnreachable" };

export interface MissingHeader {
    header: string;
    /** The including file as the caller named it (or a library/framework path), and the line. */
    file: string | null;
    line: number | null;
    suggestions: Array<{ owner: string; name: string; version: string; description: string }>;
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
    /** Registry libraries (lib_deps) built: name@version, and how many of their TUs came from the cache. */
    registry?: { libraries: string[]; compiled: number; cached: number };
}

export type CompilePhase = "download" | "compile" | "link" | "done";

export interface CompileProgress {
    phase: CompilePhase;
    /** Bytes (download) or steps (compile/link) done and expected. */
    loaded: number;
    total: number;
    /** What is being worked on, for people: a library name while it downloads or compiles. */
    label?: string;
}
