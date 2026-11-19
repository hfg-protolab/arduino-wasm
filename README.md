# arduino-wasm

Compile Arduino sketches for AVR (Uno, Nano) and ESP32 (esp32, esp32-s3, esp32-c3) entirely in the browser — GCC and binutils compiled to WebAssembly, no build server. The output is byte-identical to a native PlatformIO build of the same configuration (AVR built without LTO).

Status: phase 1 (pack builder) and phase 2 (runtime) work end to end in Node/Bun and headless Chrome for all six boards (`uno`, `nano`, `nano-old`, `esp32dev`, `esp32-s3`, `esp32-c3`). The pack builder skips boards whose WebAssembly toolchain is missing from `.build/toolchains/`.

## How it works

- **Toolchain:** the real GCC/binutils of the Arduino/PlatformIO toolchains (same versions), compiled to WebAssembly with Emscripten (`toolchains/`). Only `cc1`/`cc1plus`, `as` and `ld` — the driver is TypeScript; the command lines are the native driver's `-###` output, stored in the pack.
- **Packs** (`pack/`, format in [docs/pack-format.md](docs/pack-format.md)): per board, built ahead of time from a native PlatformIO install — precompiled core and libraries (debug-stripped), the framework archives split into content-addressed members with a symbol index (ESP32), a header bundle, a precompiled `Arduino.h` (ESP32), the constant flash images. Served from any static host.
- **Runtime** (`src/`): `.ino` → `.cpp` exactly like PlatformIO, library selection like PlatformIO's chain LDF, `cc1plus` + `as` per translation unit (in a Web Worker, cached per TU), lazy linking (only the archive members `ld` will load are fetched), `ld`, then Intel HEX or the ESP32 app image (`elf2image` port) and PlatformIO's size report.

## Using it

```ts
import { compileFirmware, prewarm } from "arduino-wasm";

const packBaseUrl = "https://static.example/arduino-wasm/2026.11.18-1/";

// optional, while the user is still typing: download the pack and compile the tools
await prewarm("esp32dev", { packBaseUrl });

const res = await compileFirmware(
    { board: "esp32dev", files: [{ path: "Blink.ino", content: source }] },
    { packBaseUrl, onProgress: (p) => console.log(p.phase, p.loaded, p.total) },
);
if (res.ok) flash(res.files); // [{ name: "firmware.bin", address: 0x10000, data }, bootloader, partitions, boot_app0]
else show(res.errors);        // [{ file: "Blink.ino", line: 5, column: 3, message: "…" }]
```

In a page, run it off the main thread: bundle `src/worker.ts` (e.g. `bun build src/worker.ts --target browser`) and use

```ts
import { createCompilerWorker } from "arduino-wasm/pool";
const compiler = createCompilerWorker("/worker.js");
const res = await compiler.compile(request, { packBaseUrl, onProgress });
```

The worker compiles the translation units of a multi-file sketch in parallel in a small pool of nested workers (`poolSize`, default `min(4, cores − 1)`).

Options of `compileFirmware`: `fetch` (custom fetch, e.g. from disk in tests), `cacheStorage` (keep pack files in Cache Storage, default on where available), `cache` (object cache per TU, default on), `usePch` (default on), `executor` (tool runner), `keepIntermediates` (objects/ELF in the result, for tests).

Caching: pack files are content-addressed (serve `files/` with `Cache-Control: immutable`), kept in Cache Storage (offline after the first compile), tools are compiled with `WebAssembly.compileStreaming` (Chrome caches the machine code), compiled modules and unpacked headers stay in memory, and objects are cached by `sha256(pack version, board, argv, sources)`.

The tool glue is evaluated with `new Function` (it must not detect Node): a page with a Content-Security-Policy needs `'unsafe-eval'` (or `'wasm-unsafe-eval'` plus a CSP-friendly loader) for the worker script.

## Building a pack

Needs PlatformIO (`~/.platformio`, or `PLATFORMIO_CORE_DIR` / `PLATFORMIO_PACKAGES_DIR` / `PIO`; allowed libraries under `PACK_LIBS`, default `.build/pack-work/libs`) with the platforms of `pack/config.json` and the WebAssembly toolchains in `.build/toolchains/<toolchain>/{cc1plus,cc1,as,ld}.{js,wasm}` (built by `toolchains/*/Dockerfile`). Then:

```sh
bun pack/build.ts                         # every board with a toolchain → .build/packs/<packVersion>/
bun pack/build.ts --boards uno,nano,nano-old
```

`pack/config.json` holds the boards (PlatformIO platform@version, board, framework, toolchain, `noLto`, `pch`, `lazyLink`), the allowed libraries (PlatformIO specs, grouped like the AI Hub image's `/opt/pio-libs/<dir>`), the curated extra ESP-IDF headers (a proposal — see "Open decisions") and the C/C++ standard headers of the header closure. Build all boards of a family (AVR, ESP32) in one run: the shared header blob is computed across the boards of that run.

What the builder does per board: a probe build (`pio run -v`, one TU per library header so every library is compiled), `-###` of the sketch compile, a `.c` compile and the link, mapping of every native path onto the AI Hub image's layout (`/opt/pio/packages`, `/opt/pio-libs`, `/work/project`), `--strip-debug` of every shipped archive and object, the symbol index and base blob for lazy linking, the header closure (`-M` of every candidate after `#include <Arduino.h>`), the PCH (generated by the wasm `cc1plus` itself — a `.gch` only works with the binary that wrote it), the flash images and size limits, and `licenses.json` with the source offer for the GPL tools.

Production packs (and the test fixtures, `scripts/generate-fixtures.sh`) are built inside the PlatformIO image in `pack/pio-image/`, which has PlatformIO, the platforms and allowed libraries at the pack's virtual paths, and bun: `__FILE__` strings and debug paths in the core and libraries carry the build machine's paths, and in that image they are `/opt/pio/…` and `/opt/pio-libs/…` instead of a developer's home directory.

```sh
docker build -t arduino-wasm-pio pack/pio-image
docker run --rm -u 0 -v "$PWD:/src" -v arduino-wasm-work:/src/.build/pack-work -w /src arduino-wasm-pio bun pack/build.ts
```

The image was the AI Hub's server-side firmware build (`aihub-pio`), retired once compiling moved to the browser; its platform pins and `libraries.txt` must match `pack/config.json`. Tests that compare against `pio run` (`test/e2e.test.ts`, the corpus) must run in the same environment as the pack build (same paths in `__FILE__`), i.e. in the image for a production pack.

### Hosting a pack

A pack is static files. Serve `files/*` immutable and the JSON files briefly cached, with `application/wasm` for `.wasm`. Precompress with `bun pack/compress.ts <packDir>` (writes `<file>.br`; `--br-only` also drops the raw copies) and let the host send them as `Content-Encoding: br`. To hand a pack to a deployment, attach it to a GitHub release:

```sh
bun pack/compress.ts .build/packs/<packVersion> --br-only   # once per pack; Brotli q11 is slow and memory-hungry
tar -czf pack.tar.gz -C .build/packs/<packVersion> .
gh release create pack-<packVersion> pack.tar.gz
```

(The AI Hub's frontend image takes the checkout and that release as Docker build contexts and serves the pack itself.)

## Tests and benchmarks

```sh
bun test src                     # unit tests (ino, elf, hex, esp-image, size, ar, resolve, ldf, driver, bundle)
bun test test/e2e.test.ts        # end to end against .build/packs/<version> (skipped without a pack)
bun test/browser/server.ts       # headless Chrome: compileFirmware in a Web Worker, packs over HTTP (port 8765)
bun run test:corpus              # verification corpus (below); --board uno,esp32dev --sketch Blink,lib/Adafruit* --slots 3 --list
```

The end-to-end test compiles Blink, an SSD1306 sketch and a multi-file sketch (`.ino` + `.cpp` + `.c` + `.h`) for `uno` (Blink also for `nano`/`nano-old`), Blink and a WiFi/HTTP sketch for `esp32dev`, `esp32-s3` and `esp32-c3`, and checks
1. the ELF against a native `ld` over the same stripped pack files (full archives instead of the lazily reduced ones) — byte-identical, except that on ESP32 `ld` names `crtbegin.o`/`crtend.o` symbols after the path it opened (the native link runs under another root), so there the stripped ELF and the symbol list are compared;
2. against `pio run` (`test/reference-build.ts`, same `platformio.ini` as the AI Hub, AVR without LTO): `.hex` identical; ESP32 app image identical outside the ELF-SHA-256 field (0xb0), checksum and appended digest — except up to 24 bytes in `.eh_frame` (WiFi sketch), the known effect of `--strip-debug` on FDEs of discarded COMDAT copies (spike/link/FINDINGS.md, pitfall 1);
3. diagnostics (file/line/column in the sketch's own files, linker errors) and `prewarm`.

The verification corpus (`test/corpus/`) runs every example of the allowed libraries and their dependencies, Arduino's built-in examples 01–04 (vendored) and arduino-esp32's ESP32/WiFi/Preferences examples on every applicable board (~660 cases), plus deliberately broken sketches, and checks per case: byte identity with a native `ld` over the same pack files; the image against `pio run` (ESP32 masked like above; differences inside `.eh_frame` are recorded, any other difference fails; a sketch that expands `__FILE__` is compared with a pio build that maps its project dir to `/work/project`); equal size report; for broken sketches the same errors as native gcc/ld. Sketches that do not compile natively are skipped; sketches that compile natively but include a header the pack lacks are listed as header-bundle gaps. Reference builds run in a few reused PlatformIO projects per board and are cached in `.build/corpus-ref/<packVersion>/` (first run ≈ 40 min, later runs only the wasm side); results go to `.build/corpus/results.json`.

## Layout

- `toolchains/<arch>/` — Dockerfiles that build the WebAssembly toolchains
- `pack/` — pack builder (`build.ts`, `probe.ts`, `config.json`)
- `src/` — runtime library (browser-safe; `compile.ts`, `driver.ts`, `ldf.ts`, `resolve.ts`, `cache.ts`, `worker.ts`, `pool.ts`, plus `ino`, `elf`, `hex`, `esp-image`, `size`, `ar`)
- `docs/pack-format.md` — the pack format
- `test/` — end-to-end test, reference builds, browser harness
- `spike/` — phase 0 spikes and findings

## Licenses

The code in this repository: MIT (`LICENSE`). The WebAssembly builds of GCC and binutils are GPL; each pack's `licenses.json` lists the exact upstream sources and patches. Arduino cores (LGPL), ESP-IDF (Apache-2.0) and libraries keep their own licenses, listed per pack.
