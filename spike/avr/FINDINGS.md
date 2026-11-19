# Phase 0 – AVR (uno, nano, nano-old): Ergebnis

**Go.** `cc1plus`, `cc1`, `as` und `ld` laufen als WebAssembly in Node und in Chrome. Die Ergebnisse sind **byte-identisch** zum heutigen nativen Build (PlatformIO `atmelavr@5.3.0`, toolchain-atmelavr 1.70300.191015, framework-arduino-avr 5.4.0). Verglichen wird jeweils mit dem nativen Build **ohne LTO** (`build_unflags = -flto -fuse-linker-plugin`), weil der WASM-Weg kein LTO hat.

## Geprüft

| Prüfung | Ergebnis |
|---|---|
| Blink, uno: Sketch in WASM, Core-Archive nativ, `ld` in WASM | `.hex` identisch (Node und Chrome), auch `.elf` identisch |
| SSD1306-Sketch (Adafruit SSD1306 2.5.17, GFX 1.13.0, BusIO 1.17.4, Wire, SPI), uno | `.hex` identisch (Node und Chrome) |
| Alle 38 Übersetzungseinheiten des SSD1306-Builds (Core, Variant, 5 Bibliotheken; `.c`, `.cpp`, `.S`) in WASM | **38/38 `.o` byte-identisch** |
| Dasselbe für `nanoatmega328new` und `nanoatmega328` | 38/38 `.o`, `.hex` identisch |
| Blink komplett (26 Übersetzungseinheiten) | 26/26 `.o`, `.hex` identisch |

Alle Prüfungen sind mit der Ausgabe des fertigen Dockerfiles wiederholt worden.

## Flash-Mehrbedarf ohne LTO (uno, nativ gemessen)

| Sketch | Flash mit LTO (heute) | ohne LTO | Δ Flash | RAM mit / ohne |
|---|---|---|---|---|
| Blink | 924 B (2,9 %) | 1058 B (3,3 %) | +134 B (+14,5 %) | 9 / 9 B |
| SSD1306 | 14 690 B (45,5 %) | 15 906 B (49,3 %) | +1216 B (+8,3 %) | 525 / 576 B |

Das ist absolut wenig, etwa 4 % des Uno-Flashs beim SSD1306-Sketch. Spürbar wird es nur bei Sketchen, die heute knapp unter 32 256 B liegen. `lto1.wasm` bleibt eine spätere Option und ist für Phase 1 nicht nötig.

## Größen

Werkzeuge (Emscripten 4.0.10, `-O2`, Ausgabe des Dockerfiles):

| Datei | roh | Brotli q11 |
|---|---|---|
| cc1plus.wasm | 10,81 MB | 2,91 MB |
| cc1.wasm | 9,79 MB | 2,62 MB |
| ld.wasm | 0,97 MB | 0,26 MB |
| as.wasm | 0,58 MB | 0,21 MB |
| 4 × .js-Lader | 75–117 KB | je ca. 18–24 KB |
| **Summe** | **22,5 MB** | **6,08 MB** |

Daten pro Board (uno, gemessen):
- **Header-Abschluss des SSD1306-Sketches** (per `-M`): 57 Dateien, ca. 0,5 MB roh, **ca. 80 KB Brotli**. Der ganze `avr/include`-Baum für alle Chips hätte 27 MB roh bzw. 380 KB Brotli; auch das wäre tragbar.
- **Link-Eingaben** (libgcc.a, libc.a, libm.a, libatmega328p.a, crtatmega328p.o): 6,3 MB roh, davon libgcc.a allein 5,9 MB, überwiegend Debug-Info. **Ca. 300 KB Brotli**, mit `avr-strip -g` noch weniger.
- **Vorkompilierter Core, Variant und Bibliotheken** (7 Archive): 267 KB roh, **ca. 55 KB Brotli**.

**Erster Download AVR: ca. 6,5 MB Brotli.** Wird `cc1` erst bei `.c`- oder `.S`-Dateien nachgeladen, sind es ca. 3,8 MB. Das Ziel von 10–15 MB ist damit klar unterschritten.

## Zeiten

Gemessen auf Apple Silicon, während andere Agents parallel GCC bauten (bis über 400 % CPU). Die Zahlen sind deshalb eher pessimistisch.
- *cold* = erster Lauf direkt nach `WebAssembly.compile(Streaming)`.
- *warm* = ab dem zweiten Lauf im selben Tab bzw. Prozess.
- Jeder Schritt läuft in einer frischen Instanz aus dem schon kompilierten `WebAssembly.Module`; das Instanziieren kostet 1–5 ms.

**Chrome 157 headless, nur MEMFS** (nur gebündelte Dateien). Die Gesamtzeit enthält das Befüllen von MEMFS pro Instanz (3–15 ms je Schritt).

| | compileStreaming (alle 3) | cc1plus | as | ld | **gesamt cold** | **gesamt warm** |
|---|---|---|---|---|---|---|
| Blink | 75–80 ms | 133–157 → 20–30 ms | 5–7 → 1 ms | 12–18 → 3 ms | **ca. 0,21 s** | **35–58 ms** |
| SSD1306 | 75–130 ms | 174–265 → 30–60 ms | 6–9 → 1 ms | 18–25 → 4–7 ms | **0,22–0,34 s** | **50–90 ms** |

**Node 25 mit NODEFS:**
- Blink: cold 0,45–0,53 s, warm 70–170 ms.
- SSD1306: cold 0,6–1,3 s, warm 0,13–0,4 s. Die Werte schwanken stark wegen der parallelen Builds.

Zum Vergleich nativ (x86-Binary unter Rosetta): `avr-g++ -c` des SSD1306-Sketches braucht warm 70–80 ms.

Alle 38 Übersetzungseinheiten nacheinander in Node: ca. 6 s. Das ist im Browser nicht nötig, weil Core und Bibliotheken vorkompiliert werden.

**Speicher:** Jede Instanz bleibt bei den 64 MB Startspeicher; bei diesen Sketchen wächst nichts. Der Node-Prozess braucht 180–330 MB RSS.

Ziele „erster Compile 1–2 s, Re-Compile < 1 s“: **weit unterschritten** (ca. 0,2–0,35 s bzw. ca. 0,05–0,09 s, plus Download).

## Was dafür nötig war

Ausgabe des Dockerfiles: `cc1`, `cc1plus`, `as`, `ld`, jeweils als `.js` und `.wasm` (MODULARIZE, `createTool`, exportiert `FS`, `callMain` und `HEAPU8`).

1. **Arduinos Quellen statt Vanilla.**
   - Vanilla-GCC 7.3.0: 15 von 38 Objekten anders (andere Befehlsreihenfolge).
   - Mit dem Atmel/Arduino-Patch und `--enable-fixed-point`: noch 11 von 38 anders.
   - binutils: Atmels 2.26.20160125-Tarball plus Arduino-Patch.
2. **GCC muss den Ziel-Assembler prüfen können.**
   - Ohne ihn nimmt GCCs `configure` einen alten gas an und erzeugt `.gnu.linkonce.*` statt COMDAT-`.group`.
   - Lösung: dieselben Atmel-binutils nativ für Linux bauen und `--with-as`/`--with-ld` darauf zeigen lassen. Sie werden nicht ausgeliefert.
   - Danach sind alle 38 Objekte identisch.
3. **Indirekte Aufrufe mit falscher Signatur** (WASM prüft das, x86 nicht):
   - gas: drei Pseudo-Op-Handler sind nach `void (*)(int)` gecastet. Behoben mit `binutils-2.26-wasm-fnptr.patch` (drei Wrapper in `gas/config/obj-elf.c`).
   - ld/bfd: viele solche Casts (`bfd_false` und ähnliche in den Target-Vektoren). ld wird deshalb mit `-sEMULATE_FUNCTION_POINTER_CASTS=1` gelinkt.
   - cc1 und cc1plus: kein Problem.
4. **Kleinkram beim Bauen:**
   - `ac_cv_func_psignal=yes` (libiberty).
   - `HOST_CC=gcc` für gmp.
   - `-sINITIAL_MEMORY=64MB`; muss größer als `STACK_SIZE` sein, sonst scheitert schon der configure-Test.
   - `all-gcc` bricht spät an `gcov-tool` ab (kein `ftw`); danach wird `make -C gcc cc1 cc1plus` aufgerufen.
5. **Hinweise für den Treiber in Phase 2:**
   - `ld` sucht sein Default-Linker-Skript relativ zu `argv[0]`. Also `thisProgram: '/ld/ld'` setzen und `avr5.xn` nach `/ld/ldscripts/` legen. Die Skripte kommen aus dem nativen Paket; sie sind Atmel-gepatcht und weichen von denen eines Vanilla-Builds ab.
   - Pfade wie `<tc>/bin/../lib/gcc/avr/7.3.0/` (`-iprefix`) lösen in MEMFS nur auf, wenn `<tc>/bin` als Verzeichnis existiert. Es muss vor dem Lauf angelegt werden.
   - `Module.callMain(args)` verändert das übergebene Array (stellt argv[0] vorne an). Immer eine Kopie übergeben.
   - `quit` überschreiben; der Exit-Status kommt über die geworfene `ExitStatus`.
   - Die Kommandozeilen stammen aus `avr-g++ -###` des nativen Treibers. `collect2` wird zu `ld` ohne die `-plugin*`-Argumente. So sollen sie dann im Manifest stehen.

## Quellen (für das GPL-Quellenangebot)

| Komponente | Quelle | SHA-256 |
|---|---|---|
| GCC 7.3.0 | https://ftp.gnu.org/gnu/gcc/gcc-7.3.0/gcc-7.3.0.tar.xz | 832ca6ae04636adbb430e865a1451adf6979ab44ca1c8374f61fba65645ce15c |
| Atmel/Arduino-GCC-Patch | https://raw.githubusercontent.com/arduino/toolchain-avr/7.3.0-atmel3.6.1-arduino7/avr-gcc-patches/atmel-patches-gcc.7.3.0-arduino2.patch | 96782c75dd11e994e1ab9250c41fc5cd81ba65bbcf44383cd9d660d01cc85f97 |
| binutils 2.26.20160125 (Atmel AVR Toolchain 3.6.1) | http://downloads.arduino.cc/tools/opensource/Atmel-AVR-GNU-Toolchain/3.6.1/avr-binutils.tar.bz2 | 7f2ee50c3867ca13be47aee7925c4c9182b15cb5fe6ace23849ee9005081a340 |
| Arduino-binutils-Patch | https://raw.githubusercontent.com/arduino/toolchain-avr/7.3.0-atmel3.6.1-arduino7/binutils-patches/00-binutils-data_region_length.patch | d9e9f183bad9e1cfe27f3569163ccd3c39b1784b12978b47a2206eb31e2547e8 |
| eigener Patch | `toolchains/avr/binutils-2.26-wasm-fnptr.patch` | – |
| GMP 6.1.2 | https://ftp.gnu.org/gnu/gmp/gmp-6.1.2.tar.xz | 87b565e89a9a684fe4ebeeddb8399dce2599f9c9049854ca8c0dfbdea0e21912 |
| MPFR 3.1.6 | https://ftp.gnu.org/gnu/mpfr/mpfr-3.1.6.tar.xz | 7a62ac1a04408614fccdc506e4844b10cf0ad2c2b1677097f8f35d3a1344a950 |
| MPC 1.0.3 | https://ftp.gnu.org/gnu/mpc/mpc-1.0.3.tar.gz | 617decc6ea09889fb08ede330917a00b16809b8db88c29c31bfbb49cbf88ecc3 |
| Emscripten | Docker-Image `emscripten/emsdk:4.0.10-arm64` | – |

Arduino baut selbst mit MPFR 3.1.0; bei diesen Tests hatte das keine Wirkung. Zielbibliotheken (libgcc.a, avr-libc, crt, ldscripts) stammen unverändert aus PlatformIOs `toolchain-atmelavr` 1.70300.191015. Das ist Arduinos Build 7.3.0-atmel3.6.1-arduino7 (macOS, x86_64, gebaut von Arduinos Jenkins).

## Abweichungen und offene Risiken

- **Bibliotheksversionen:** Für den Spike per `lib_deps` installiert (GFX 1.13.0, BusIO 1.17.4). Das `aihub-pio`-Image löst die Abhängigkeiten selbst auf; der Pack-Builder in Phase 1 muss dessen Versionen nehmen.
- **Abdeckung:** nur zwei Sketche und drei Boards, alle mit ATmega328P. Mehr deckt erst der Korpus in Phase 4 ab.
- **ld läuft mit Cast-Emulation.** Das funktioniert und kostet hier 3–25 ms. Ein größerer bfd-Patch wäre die Alternative, falls ld bei großen Sketchen zu langsam wird.
- **Optimierungsstufe:** Werkzeuge mit `-O2` gebaut. `-O3`, `-Oz` und `wasm-opt` sind noch nicht verglichen; bei diesen Zahlen unkritisch.
- **Kein Web Worker getestet:** Der Spike läuft im Haupt-Thread der Seite.
- **Fehlermeldungen:** Das GCC-Format bleibt gleich. Gegen `errors.ts` ist es noch nicht geprüft. Im Browser stehen MEMFS-Pfade in den Meldungen; die Pfade im Manifest so wählen, dass sie zu den heutigen passen.
- **Nicht geflasht:** Kein Board am Rechner. Weil das `.hex` byte-identisch ist, entsteht dadurch kein eigenes Risiko.
- **Dauer des Toolchain-Baus:** ca. 75 min bei `-j4` auf der geteilten Maschine.

## Dateien

- `toolchains/avr/Dockerfile`: reproduzierbarer Bau mit `docker buildx build --output type=local,dest=<out> toolchains/avr`.
- `toolchains/avr/binutils-2.26-wasm-fnptr.patch`
- `spike/avr/compile.mjs`: liest das Log von `pio run -v`, holt die Teilschritte per `-###` vom nativen Treiber, führt sie in WASM aus und vergleicht `.o` und `.hex`. Mit `--all` werden auch Core und Bibliotheken übersetzt. Aufruf: `node compile.mjs --project <pio-Projekt> --log <log> --tools <dir> --out <dir> [--all] [--repeat N]`.
- `spike/avr/browser/server.mjs` und `index.html`: dieselbe `plan.json` in headless Chrome mit MEMFS. Port 8765, startet Chrome selbst und vergleicht das `.hex`.
- Referenzprojekte: `platformio.ini` wie `platformioIni()`, plus `build_unflags = -flto -fuse-linker-plugin` und ein `extra_scripts`-Hook. Der Hook bewahrt die von pio erzeugte `main.ino.cpp` auf, die pio sonst löscht.
