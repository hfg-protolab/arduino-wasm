# Phase 0 – ESP32 (Xtensa, esp32dev) im Browser-Compiler: Ergebnisse

Stand 18.11.2026. **Ergebnis: Go.** `cc1plus`, `as` und `ld` laufen als WebAssembly unter Node.
Für Blink und einen WiFi-Sketch kommen `.s`, `.o`, `firmware.elf` und das App-Image **byte-genau**
so heraus wie beim nativen Toolchain mit denselben Kommandozeilen. GCC-PCH funktioniert unter
Emscripten, braucht dafür aber einen kleinen Patch.

## Was die Produktion wirklich benutzt
`espressif32@7.1.3` + arduino + esp32dev ergibt:
- `framework-arduinoespressif32@4.20017.260907`: Arduino-ESP32 **2.0.17**, ESP-IDF **4.4.7** (vorkompilierte `.a`)
- `toolchain-xtensa-esp32@8.4.0+2021r2-patch5`: **GCC 8.4.0**, binutils 2.35.1, crosstool-NG `esp-2021r2-patch5`
- esptool 4.11.0

Das ist der **alte Toolchain pro Chip**. Er hat **kein dynconfig** und lädt kein `.so`. Die
Chip-Konfiguration (`xtensa-config.h`, `xtensa-modules.c`) wird über das Overlay fest
einkompiliert. Damit gibt es kein dlopen-Problem: ein WASM-Toolchain pro Chip. Der neue
vereinheitlichte `xtensa-esp-elf` mit `-mdynconfig` wird in 7.1.3 nur für reines ESP-IDF benutzt.
Bei einem späteren Wechsel auf Arduino 3.x: die Overlay-Dateien statisch einbauen statt dlopen,
ein Build pro Chip.

## Upstream-Quellen (für das GPL-Quellenangebot)
| Teil | Quelle | Stand |
|---|---|---|
| GCC 8.4.0 | https://github.com/espressif/gcc | Tag `esp-2021r2-patch4` |
| binutils 2.35.1 | https://github.com/espressif/binutils-gdb | Tag `esp-2021r2-patch4-binutils` |
| Chip-Overlay | https://github.com/espressif/xtensa-overlays | Commit `dd1cf19f6eb327a9db51043439974a6de13f5c7f`, `xtensa_esp32/{gcc,binutils}` |
| Referenz-Konfiguration | https://github.com/espressif/crosstool-NG | Tag `esp-2021r2-patch5`, `samples/xtensa-esp32-elf/crosstool.config` |
| GMP / MPFR / MPC | ftp.gnu.org | 6.2.1 / 4.1.0 / 1.2.1 |
| Host-Compiler | `emscripten/emsdk:4.0.10-arm64` | |

crosstool-NG wendet bei Git-Quellen keine eigenen Patches an. **Unser einziger Patch:**
`toolchains/esp/patches/gcc-8-pch-emscripten.patch` (nur `gcc/config/host-linux.c`).
Die Configure-Optionen sind die von `xtensa-esp32-elf-gcc -v` des nativen Pakets.
Ausnahmen: anderer Prefix, `--disable-lto --disable-plugin --without-isl`. Keine davon ändert den
erzeugten Code.

## Byte-Vergleich (`compare.sh`)
| | Blink | WiFi |
|---|---|---|
| `.s`, `.o`, `firmware.elf`, App-Image vs. nativer Toolchain | identisch | identisch |
| App-Image vs. `pio run` | 64 Bytes anders, nur ELF-SHA-256 (0xb0), Prüfsumme, Image-Hash | ebenso |

Der Unterschied zu `pio run` liegt nicht am WASM-Compiler. PlatformIO übersetzt die `.ino.cpp`
unter einem zufälligen Temp-Pfad, und der landet in den Debug-Infos. Das Image enthält bei `0xb0`
den SHA-256 des ganzen ELF. Daher unterscheiden sich schon zwei native pio-Builds. **Für den
Korpus (Phase 4):** `0xb0..0xd0`, das Prüfsummenbyte und den angehängten SHA-256 ausmaskieren oder
den Pfad festlegen. Ohne diese Felder ist alles identisch, auch mit PCH.

Stolpersteine, die den Code still verändert haben (in `build.sh` behoben):
1. GCCs configure prüft den Ziel-Assembler, objdump und readelf (SHF_MERGE, COMDAT, `.loc`-Views).
   Ohne sie wird stillschweigend zurückgefallen: kein `.rodata.str1.1`-Merging, andere
   `.gcc_except_table`, das WiFi-Image war 16 Bytes größer. Lösung: native xtensa-binutils
   derselben Quelle, nur für configure (`--with-as/--with-ld`, `*_FOR_TARGET`).
2. GCC 8 von Espressif verlangt C++11 als Host-Compiler (`-std=gnu++11`). Dazu
   `ac_cv_func_psignal=yes` (libiberty). gcov/gcov-tool kompilieren nicht gegen libc++, darum
   `make -k all-gcc || true` und danach `make -C gcc cc1 cc1plus`.

## PCH
Funktioniert. GCC 8 kann ein PCH nicht relozieren, und unter wasm32 gibt es kein mmap an fester
Adresse. Der Patch reserviert deshalb beim Start per Konstruktor eine 96-MiB-Arena. Der Start ist
für ein gegebenes Binary deterministisch, also liegt die Arena beim Schreiben und Lesen an
derselben Adresse. Ohne PCH wird sie sofort freigegeben.
Der `.gch` wird vom WASM-`cc1plus` selbst erzeugt (`compile.mjs --gen-pch`): `Arduino.h` → 20,8 MB,
Brotli 2,9 MB, ~5–6 s. Benutzt wird er per `-include`. Der erzeugte Code ist identisch. Ein PCH
gilt nur für dieses Binary und diese Flags, also pro Board und Pack-Version in CI erzeugen.

## Messungen
Node 25, Apple Silicon, Maschine stark ausgelastet (Load 12–24). WASM mit `-O2`.
„warm“ = Modul wiederverwendet, neue Instanz, Eingaben in MEMFS.

| | Blink | Blink+PCH | WiFi | WiFi+PCH |
|---|---|---|---|---|
| cc1plus warm | 250–340 ms | 50–110 ms | 330–460 ms | 170–370 ms |
| as warm | ~10 ms | ~10 ms | ~15 ms | ~15 ms |
| ld warm (volle Archive, 181 MiB) | 0,7–1,0 s | 0,7–1,0 s | 1,4–1,5 s | 1,4–1,5 s |
| **gesamt warm** | **~1,0 s** | **~0,8 s** | **~1,9 s** | **~1,7 s** |
| gesamt kalt (1. Lauf) | 2,9 s | 1,7 s | 3,9 s | 3,1 s |

Nativ unter derselben Last: Compile 1,2–1,9 s, ld ~1,3 s CPU. Der WASM-Weg ist also nicht
langsamer, der Link dominiert.
Spitzen-Speicher (WASM): cc1plus 152 MiB (davon 96 MiB Arena, ohne PCH unberührt), as 16 MiB,
ld 144–172 MiB, dazu die MEMFS-Eingaben im JS-Heap.

## Größen (Brotli -q 11)
| Datei | roh | Brotli |
|---|---|---|
| cc1plus.wasm | 12,3 MB | 3,27 MB |
| cc1.wasm | 11,1 MB | 2,96 MB |
| as.wasm | 0,93 MB | 0,31 MB |
| ld.wasm | 1,15 MB | 0,33 MB |
| JS-Glue je Tool | 0,13 MB | 0,02 MB |
| Header-Abschluss Blink / WiFi | 3,4 / 4,3 MB | 0,41 / 0,52 MB |
| PCH Arduino.h | 20,8 MB | 2,9 MB |
| Link-Eingaben, volle `.a` | 181 MB | 39,5 MB |
| dieselben mit `--strip-debug` | 43 MB | 11,8 MB |

Erster Download ohne Lazy-Linking: ≈ 19 MB (ungestrippt ≈ 47 MB).

## Go/No-Go
- Compile warm > 15 s? Nein, 1–2 s, kalt ≤ 4 s. ✔
- Erster Download > 60 MB? Nein, ~19 MB. ✔
- **Go.** Die Schätzungen im Plan sind eher pessimistisch.

## Offen / nicht getestet
- Chrome, echtes Flashen.
- Dockerfile als Ganzes und `build.sh fetch`. Die Schritte liefen einzeln im emsdk-Container,
  die Quellen dort von Hand entpackt. Das Dockerfile braucht `native-headers/include` im Kontext.
- Ob `--strip-debug` am Image wirklich nur das ELF-SHA-Feld ändert.
- `-O3` nicht ausprobiert.
- `cc1` (für `.c`) nicht verglichen.
- `.ino` → `.cpp`: im Spike die von pio erzeugte Datei.

## ESP32-S3 / ESP32-C3
- **S3:** `toolchain-xtensa-esp32s3@8.4.0+2021r2-patch5`, dieselben Tags, Overlay
  `xtensa_esp32s3` → `CHIP=esp32s3`. Eigene Tools (~4 MB Brotli).
- **C3:** `toolchain-riscv32-esp@8.4.0+2021r2-patch5`, gleiche Tags, kein Overlay,
  `TARGET=riscv32-esp-elf`, Flags aus `gcc -v` des Pakets. PCH-Patch gilt unverändert.
- Kommandozeilen je Board mit `extract-manifest.mjs` aus `g++ … -###`.
