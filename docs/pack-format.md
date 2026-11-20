# Pack format (version 1)

A **pack** is everything the browser needs to compile a sketch for a set of boards, built ahead of
time by `pack/build.ts` and served as static files from any host. Nothing in a pack depends on the
sketch. All paths below are relative to the pack base URL (`packBaseUrl`, e.g.
`https://cdn.example/arduino-wasm/2026.11.18-1/`).

```
index.json                    pack index: version, boards, licenses
boards/<board>.json           board manifest (small, read first)
files/<hash>.<ext>            content-addressed files (immutable, cache forever)
licenses.json                 components, licenses, source offer
```

- `<hash>` = first 32 hex chars of the SHA-256 of the file's bytes. Identical files (same compiler
  for three AVR boards, shared header blob, the same framework member in two archives) are stored
  once. `ext` is informative only (`wasm`, `js`, `awb`, `o`, `a`, `gch`, `json`, `bin`).
- `index.json` and `boards/*.json` live inside the versioned directory, so they are immutable too.
  Serve everything with `Cache-Control: public, max-age=31536000, immutable`, and with
  `Content-Encoding: br` where the host can (the sizes reported by the builder are Brotli sizes).

## FileRef

Every reference to a file is a `FileRef`:

```ts
{ file: "files/3f1c….wasm", size: 12251169, sha256: "3f1c…(64 hex)" }
```

`size` is the raw (uncompressed) size, used for progress. The runtime may verify `sha256`.

Build all boards of a family in one builder run: the shared header blob is the set of
(path, content) pairs present on every board of the family in that run.

## Bundle blob (`.awb`)

Many small files (headers, archive members) travel as one blob:

```
"AWB1"                      4 bytes magic
u32 LE  n                   byte length of the JSON table
JSON    [{ "p": path, "n": byteLength }, …]   (UTF-8, n bytes)
data                        the files' bytes, concatenated in table order
```

`p` is an absolute path in the compiler's virtual file system (headers), or a member hash (lazy
link base blob).

## Virtual file system

The compilers run on MEMFS with the same layout as the AI Hub's PlatformIO image, so messages and
`__FILE__` look like today's builds:

| what | path |
|---|---|
| PlatformIO packages (toolchain sysroot, framework, IDF) | `/opt/pio/packages/<package>/…` |
| allowed libraries | `/opt/pio-libs/<dir>/<library>/…` |
| project (cwd of every tool) | `/work/project` |
| sketch sources | `/work/project/src/<file>` |
| build dir (objects, precompiled library archives) | `/work/project/.pio/build/<env>/…` |

The builder maps the native paths of its own machine onto these roots
(`config.json → virtualRoots`).

## `index.json`

```ts
{
  format: 1,
  packVersion: "2026.11.18-1",
  boards: { "uno": "boards/uno.json", … },
  licenses: "licenses.json"
}
```

## `boards/<board>.json` — BoardManifest

```ts
interface BoardManifest {
  format: 1;
  packVersion: string;
  id: string;                       // "uno"
  name: string;                     // "Arduino Uno"
  arch: "avr" | "esp32";
  chip?: "esp32" | "esp32s3" | "esp32c3";
  platform: string; board: string; framework: string;   // PlatformIO identity (informational)
  env: string;                      // PlatformIO env name used in paths (= id)

  /** WebAssembly tools. `js` is the Emscripten MODULARIZE glue (exports `createTool`). */
  tools: Record<"cc1plus" | "cc1" | "as" | "ld", { js: FileRef; wasm: FileRef; thisProgram: string }>;

  fs: {
    cwd: string;                    // "/work/project"
    srcDir: string;                 // "/work/project/src"
    buildDir: string;               // ".pio/build/<env>" (relative to cwd, as pio uses it)
    /** Directories that must exist before a tool runs (e.g. "<tc>/bin" for -iprefix "<tc>/bin/../lib/…"). */
    mkdirs: string[];
  };

  /** Header bundles, unpacked into the FS of every compiler run (shared family blob + board delta). */
  headers: FileRef[];

  /**
   * argv templates (no argv[0]) taken from the native driver's `-###`. Placeholders:
   *   ${SRC}       source path as pio passes it ("src/main.ino.cpp")
   *   ${DUMPBASE}  basename of the source (GCC ≥ 11: `-dumpbase ${DUMPBASE}.cpp`)
   *   ${OBJ}       object path (".pio/build/<env>/src/main.ino.cpp.o")
   *   ${OBJDIR}    directory of ${OBJ} (GCC ≥ 11: `-dumpdir ${OBJDIR}/`)
   *   ${ASM}       cc1/cc1plus output = as input ("/tmp/<n>.s")
   *   ${LIBINC}    expands to 0..n arguments: "-I<dir>" for each used library, in library order
   */
  compile: {
    cpp: { cc1plus: string[]; as: string[] };
    c:   { cc1: string[]; as: string[] };
  };

  /** Precompiled Arduino.h (ESP32). Used for the generated .ino.cpp only. */
  pch?: {
    gch: FileRef;
    /** Where the .gch goes; the header copy next to it is `path` without ".gch". */
    path: string;                   // "/pch/Arduino.h.gch"
    header: string;                 // virtual path of the real Arduino.h (copied to the pch dir)
    /** Inserted at the front of the cc1plus argv. */
    args: string[];                 // ["-include", "/pch/Arduino.h"]
  };

  /** Libraries a sketch may use (framework built-ins + allowed), in link/include order. */
  libraries: LibraryEntry[];

  link: {
    /**
     * ld argv template. ${OBJS} → library objects of the used libraries (pioarduino, lib_archive = no)
     * then the sketch objects (pio order), ${LIBS} → used library archives, ${ELF}.
     */
    ld: string[];
    /** Files ld always needs (crt objects, linker scripts, AVR: every framework archive), at their virtual paths. */
    files: Array<{ path: string } & FileRef>;
    /** Lazy linking (ESP32): the framework archives are not in `files`. */
    lazy?: {
      index: FileRef;               // LinkIndex JSON (below)
      base: FileRef;                // .awb with the members an empty sketch needs, p = member hash
    };
  };

  /** Turning the ELF into what gets flashed. */
  output:
    | { kind: "hex"; remove: string[] }                       // avr: firmware.hex (objcopy -O ihex -R .eeprom)
    | { kind: "esp-image"; image: ElfToImageOptions; appAddress: number;
        images: Array<{ name: string; address: number } & FileRef> };   // bootloader, partitions, boot_app0
    | { kind: "esp8266-image"; image: Esp8266ImageOptions; eboot: FileRef; appAddress: number };
      // esp8266: elf2bin.py (eboot + app + CRC) → one firmware.bin at 0x0 (src/esp8266-image.ts)

  size: { family: "avr" | "esp32" | "esp8266"; flashMax: number; ramMax: number };

  /** Download sizes measured by the builder (raw / Brotli), for UI and reports. */
  stats: Record<string, { raw: number; brotli: number }>;
}

interface LibraryEntry {
  name: string;                     // PlatformIO name, "Adafruit SSD1306"
  version?: string;
  origin: "framework" | "allowed";
  /** -I directories (virtual), in the order pio adds them. */
  includeDirs: string[];
  /** Header names a sketch can #include that select this library (relative to includeDirs). */
  headers: string[];
  /** Direct dependencies (library names), as PlatformIO's chain LDF found them. */
  deps: string[];
  /** Precompiled, debug-stripped archive at its pio path (relative to cwd); absent for header-only. */
  archive?: { path: string } & FileRef;
  /**
   * pioarduino builds libraries with `lib_archive = no`: their objects (debug-stripped, pio's paths
   * and order) are linked one by one, before the sketch's objects, instead of an archive.
   */
  objects?: Array<{ path: string } & FileRef>;
}
```

### Library selection (runtime LDF)

Like PlatformIO's `lib_ldf_mode = chain`: scan the sketch files for `#include <…>` / `"…"`
(conditionals ignored), following the sketch's own headers; every included name found in a
library's `headers` selects that library; then add `deps` transitively. Include dirs (`${LIBINC}`)
and archives (`${LIBS}`) are emitted in manifest order restricted to the selected set (the builder
writes the manifest in PlatformIO's order).

## LinkIndex (lazy linking, ESP32)

```ts
interface LinkIndex {
  /** Symbol names; every symbol below is an index into this table. */
  strings: string[];
  /** Resolver input sequence = ld's input order. */
  inputs: Array<
    | { kind: "objects" }                                   // ${OBJS}
    | { kind: "libs" }                                      // ${LIBS}
    | { kind: "object"; path: string; syms: Sym[] }         // crt objects (also in link.files)
    | { kind: "archive"; archive: number }                  // index into `archives`
    | { kind: "groupStart" } | { kind: "groupEnd" }
  >;
  roots: string[];                  // -u, ENTRY, EXTERN
  wraps: string[];                  // --wrap
  archives: Array<{
    path: string;                   // virtual path ld opens (resolved through -L)
    members: Array<{
      n: string;                    // member name (kept: linker scripts match on it)
      h: string;                    // hash → files/<h>.o (or inside the base blob)
      s: number;                    // size
      d?: number[]; w?: number[]; c?: number[]; u?: number[]; uw?: number[];  // def, weakdef, common, undef, weakundef
      a?: number[];                 // armap symbols of this member, in armap order
    }>;
  }>;
}
```

The runtime resolves the closure (`src/resolve.ts`, exact model of GNU ld's archive scan), fetches
the members not in the base blob as `files/<h>.o`, and writes one small archive per framework
archive (same file name and path, original member order, armap filtered) — an empty `!<arch>\n`
where nothing is needed — so ld's argv stays unchanged.

AVR (`lazy` absent): every framework archive is in `link.files` (≈ 0.15 MB Brotli).

## PCH

`pch.gch` is produced by the pack's own `cc1plus.wasm` (GCC 8/10 cannot relocate a PCH; the patched
compiler maps it at a fixed arena address that is deterministic for one binary), from the
`compile.cpp.cc1plus` template with `${LIBINC}` empty and `--output-pch` (GCC ≥ 11: two
arguments, and generated from `/pch/Arduino.h` itself, since GCC ≥ 11 writes the path the PCH was
made from into the assembly). The runtime puts it at
`pch.path`, a copy of the real `Arduino.h` next to it, and prepends `pch.args` to the cc1plus argv
of the generated `.ino.cpp` only (which starts with `#include <Arduino.h>` anyway); other `.cpp`
files compile without it. Measured: the code is identical with and without PCH.
