# Toolchains (WebAssembly)

GCC und binutils als WebAssembly, je Ziel genau vier Programme: `cc1`, `cc1plus`, `as`, `ld`
(jeweils `.wasm` plus Emscripten-Lader `.js`, MODULARIZE, `createTool`, exportiert `FS` und
`callMain`). Kein `gcc`-Treiber, kein `collect2`, kein LTO. Die Kommandozeilen kommen aus dem
Board-Manifest (`g++ -###` des nativen Treibers).

Gebaut wird aus exakt den Quellen, aus denen PlatformIOs native Toolchains gebaut sind. Das
Ergebnis erzeugt **byte-identische** `.s`, `.o`, `firmware.elf` und Flash-Images wie die native
Toolchain mit denselben Kommandozeilen.

Diese Datei ist zugleich das **GPL-Quellenangebot** für die ausgelieferten `.wasm`/`.js`.
Maschinenlesbar: [`sources.json`](sources.json).

## Bauen

Ein Befehl pro Toolchain, Ausgabe nach `.build/toolchains/<id>` (git-ignoriert):

```sh
docker buildx build --output type=local,dest=.build/toolchains/avr     toolchains/avr
docker buildx build --output type=local,dest=.build/toolchains/esp32   toolchains/esp
docker buildx build --output type=local,dest=.build/toolchains/esp32s3 --build-arg CHIP=esp32s3 toolchains/esp
docker buildx build --output type=local,dest=.build/toolchains/esp32c3 --build-arg CHIP=esp32c3 toolchains/esp
# Arduino-ESP32 3.x (pioarduino 55.03.39, GCC 14.2.0) und ESP8266 (espressif8266@4.2.1, GCC 10.3.0):
docker buildx build --output type=local,dest=.build/toolchains/esp32-v3   toolchains/esp14
docker buildx build --output type=local,dest=.build/toolchains/esp32s3-v3 --build-arg CHIP=esp32s3 toolchains/esp14
docker buildx build --output type=local,dest=.build/toolchains/riscv32-v3 --build-arg CHIP=riscv32 toolchains/esp14
docker buildx build --output type=local,dest=.build/toolchains/esp8266    toolchains/esp8266
```

- Alles wird im Dockerfile geladen und per SHA-256 geprüft. Es braucht nichts außerhalb des Repos.
- Host-Compiler: `emscripten/emsdk:4.0.10-arm64`, per Digest gepinnt
  (`sha256:46566098d0e12a11aed071a4aaa20e6a626ab3d011a246846ae2423a21b659d9`).
  - Auf x86_64 geht für `toolchains/esp` `--build-arg EMSDK_IMAGE=emscripten/emsdk:4.0.10`; `toolchains/avr` hat das Image fest im `FROM`.
  - Ob das bitgleich ist, ist ungeprüft.
- Weitere Build-Args (`toolchains/esp`):
  - `JOBS` (Default 4)
  - `OPT` (Default `-O2`, Optimierung der wasm-Programme)
- Der Build ist deterministisch:
  - Die volle Dockerfile-Ausführung für esp32 ergibt dieselben `.wasm` wie die Einzelschritte aus Phase 0.
  - Ein `--no-cache`-Lauf für avr ergibt ebenfalls dieselben `.wasm`.
- Zur Laufzeit lesen die Compiler Header, `libgcc`, newlib und `libstdc++` aus dem
  PlatformIO-Paket bzw. aus dem Pack. Diese Teile baut dieses Verzeichnis nicht.

### Bauzeiten

Gemessen auf Apple Silicon, Docker mit 8 CPUs und 7,75 GB, `-j4`, zwei Builds parallel, Last 20–26.

| id | gesamt (ein Befehl) | davon gcc | Bemerkung |
|---|---|---|---|
| avr | 31 min kalt (`--no-cache`) | 11 min | parallel zu einem esp-Build |
| esp32 | ≈ 35 min kalt (28 min mit gecachten Quellen und GMP/MPFR/MPC) | 12 min | |
| esp32s3 | 40 min kalt | 18 min | parallel zu esp32c3 |
| esp32c3 | 44 min kalt | 17 min | parallel zu esp32s3 |
| esp32-v3 | 20,7 min kalt (1241 s), `JOBS=6`, allein | 11,6 min | 19.11.2026 |
| esp32s3-v3 | 21,3 min (1278 s), `JOBS=6`, allein | 14,2 min | Quellen/GMP aus dem Cache |
| riscv32-v3 | 28,7 min kalt (1723 s), `JOBS=6`, allein | 19,9 min | `build.sh` geändert → alles neu |
| esp8266 | 10,7 min kalt (641 s), `JOBS=6`, allein | 4,5 min | |

Die chip-unabhängigen Schritte (`fetch-common` ≈ 4,5 min Download, `hostlibs` ≈ 2,7 min) liegen
in `toolchains/esp` vor `ARG CHIP`. Sie werden für alle drei Chips nur einmal gebaut, solange der
BuildKit-Cache sie hält.

### Größen

Brotli mit Qualität 11 und lgwin 24; MB = 10⁶ Byte.

| id | cc1plus.wasm | cc1.wasm | as.wasm | ld.wasm | 4 × .js | **Summe roh** | **Summe Brotli** |
|---|---|---|---|---|---|---|---|
| avr | 11,34 / 3,05 | 10,27 / 2,75 | 0,61 / 0,22 | 1,02 / 0,28 | 0,39 / 0,08 | **23,61** | **6,37** |
| esp32 | 12,25 / 3,27 | 11,15 / 2,96 | 0,93 / 0,31 | 1,15 / 0,33 | 0,41 / 0,09 | **25,88** | **6,96** |
| esp32s3 | 12,25 / 3,27 | 11,15 / 2,96 | 1,07 / 0,32 | 1,29 / 0,35 | 0,41 / 0,09 | **26,16** | **6,99** |
| esp32c3 | 12,39 / 3,30 | 11,29 / 2,99 | 0,83 / 0,28 | 1,31 / 0,31 | 0,41 / 0,09 | **26,22** | **6,97** |
| esp32-v3 | 19,08 / 4,78 | 17,20 / 4,28 | 0,98 / 0,32 | 1,35 / 0,37 | 0,46 / 0,10 | **39,07** | **9,86** |
| esp32s3-v3 | 19,08 / 4,78 | 17,20 / 4,28 | 1,11 / 0,34 | 1,49 / 0,39 | 0,46 / 0,10 | **39,35** | **9,89** |
| riscv32-v3 | 37,73 / 6,45 | 35,89 / 5,95 | 1,16 / 0,35 | 2,30 / 0,39 | 0,47 / 0,10 | **77,54** | **13,24** |
| esp8266 | 13,87 / 3,62 | 12,62 / 3,26 | 0,92 / 0,31 | 1,10 / 0,31 | 0,42 / 0,09 | **28,93** | **7,59** |

Werte in MB, roh / Brotli. Ohne `cc1`, das nur für `.c` gebraucht wird, sind es pro Toolchain
etwa 3,4–4,0 MB Brotli.

Zu den GCC-14-Toolchains:
- Sie sind rund 3 MB Brotli größer als die GCC-8-Toolchains; ohne `cc1` sind es 5,6 MB.
- riscv32-v3 ist doppelt so groß wie die Xtensa-Builds (ohne `cc1`: 7,3 MB). Ursache ist das
  RISC-V-Backend von GCC 14 mit den Vektor-Mustern (RVV) in `insn-*`.

## avr: `toolchains/avr/Dockerfile`

Passt zu PlatformIO `toolchain-atmelavr@1.70300.191015` (atmelavr@5.3.0).

- **Bauvorschrift:**
  - Repo: [arduino/toolchain-avr](https://github.com/arduino/toolchain-avr)
  - Tag: `7.3.0-atmel3.6.1-arduino7`, Commit `368b87a73e3677071fa44f2182c1ea4cc6a90557`
  - Skripte: `gcc.build.bash` und `binutils.build.bash`

| Quelle | URL | SHA-256 |
|---|---|---|
| GCC 7.3.0 | https://ftp.gnu.org/gnu/gcc/gcc-7.3.0/gcc-7.3.0.tar.xz | `832ca6ae04636adbb430e865a1451adf6979ab44ca1c8374f61fba65645ce15c` |
| binutils 2.26.20160125 (Atmel 3.6.1) | http://downloads.arduino.cc/tools/opensource/Atmel-AVR-GNU-Toolchain/3.6.1/avr-binutils.tar.bz2 | `7f2ee50c3867ca13be47aee7925c4c9182b15cb5fe6ace23849ee9005081a340` |
| GMP 6.1.2 | https://ftp.gnu.org/gnu/gmp/gmp-6.1.2.tar.xz | `87b565e89a9a684fe4ebeeddb8399dce2599f9c9049854ca8c0dfbdea0e21912` |
| MPFR 3.1.6 | https://ftp.gnu.org/gnu/mpfr/mpfr-3.1.6.tar.xz | `7a62ac1a04408614fccdc506e4844b10cf0ad2c2b1677097f8f35d3a1344a950` |
| MPC 1.0.3 | https://ftp.gnu.org/gnu/mpc/mpc-1.0.3.tar.gz | `617decc6ea09889fb08ede330917a00b16809b8db88c29c31bfbb49cbf88ecc3` |

**Patches:**
- Arduino: `avr-gcc-patches/atmel-patches-gcc.7.3.0-arduino2.patch`
  - SHA-256 `96782c75dd11e994e1ab9250c41fc5cd81ba65bbcf44383cd9d660d01cc85f97`
- Arduino: `binutils-patches/00-binutils-data_region_length.patch`
  - SHA-256 `d9e9f183bad9e1cfe27f3569163ccd3c39b1784b12978b47a2206eb31e2547e8`
- Beide kommen aus dem Tag oben.
- **Eigener Patch:** `binutils-2.26-wasm-fnptr.patch`
  - gas: drei Pseudo-Op-Handler, die auf `void(*)(int)` gecastet werden.
  - wasm prüft Typen bei indirekten Aufrufen.
  - `ld` wird stattdessen mit `-sEMULATE_FUNCTION_POINTER_CASTS=1` gelinkt.

**configure (GCC):**
```
--host=i686-pc-linux-gnu --target=avr --enable-fixed-point --enable-languages=c,c++
--disable-nls --disable-shared --disable-plugin --disable-lto --disable-libssp --disable-libada
--disable-libcc1 --without-isl --with-avrlibc=yes --with-dwarf2 --disable-bootstrap
--enable-checking=release --with-gnu-as --with-gnu-ld --with-as=<native avr-as> --with-ld=<native avr-ld>
```
Native avr-binutils aus derselben Quelle werden nur gebaut, damit GCCs configure die
Assembler-Features prüfen kann. Sie werden nicht ausgeliefert.

## esp32 / esp32s3 / esp32c3: `toolchains/esp/` (Dockerfile + build.sh)

| id | Ziel | Overlay | zusätzlich | passt zu PlatformIO |
|---|---|---|---|---|
| esp32 | `xtensa-esp32-elf` | `xtensa_esp32` | – | `toolchain-xtensa-esp32@8.4.0+2021r2-patch5` |
| esp32s3 | `xtensa-esp32s3-elf` | `xtensa_esp32s3` | – | `toolchain-xtensa-esp32s3@8.4.0+2021r2-patch5` |
| esp32c3 | `riscv32-esp-elf` | – | `--with-arch=rv32gc --with-abi=ilp32` | `toolchain-riscv32-esp@8.4.0+2021r2-patch5` |

Alle drei sind die Toolchains aus `espressif32@7.1.3`. Diese Generation hat **kein dynconfig**:
die Xtensa-Chipkonfiguration aus dem Overlay ist fest einkompiliert. Daher gibt es eine
Toolchain pro Chip.

- **Bauvorschrift:**
  - Repo: [espressif/crosstool-NG](https://github.com/espressif/crosstool-NG)
  - Tag: `esp-2021r2-patch5`, Commit `7dbd58403d012a07ee046836f625985396cfc1ca`
  - Datei: `samples/<ziel>/crosstool.config`
- crosstool-NG wendet auf Git-Quellen keine Patches an.

| Quelle | URL | Tag / Commit | SHA-256 des Archivs |
|---|---|---|---|
| GCC 8.4.0 (Espressif) | https://github.com/espressif/gcc/archive/refs/tags/esp-2021r2-patch4.tar.gz | `esp-2021r2-patch4` / `3b3d328ad0dfd53636d2d54e98b77bfcdacefac4` | `6baba8db4731a91d825e9b1f44f2a9128c6dae51074ef7b9d5318174c27fec1f` |
| binutils 2.35.1 (Espressif) | https://github.com/espressif/binutils-gdb/archive/refs/tags/esp-2021r2-patch4-binutils.tar.gz | `esp-2021r2-patch4-binutils` / `df444b49d425e05f538d7875f8e2162771c74a51` | `542a3c96f3f2dc692815ba47b60f02dc55544e69f94267112f9ded53c94242be` |
| xtensa-overlays | https://github.com/espressif/xtensa-overlays/archive/dd1cf19f6eb327a9db51043439974a6de13f5c7f.tar.gz | `dd1cf19f6eb327a9db51043439974a6de13f5c7f` | `2ff44e3932c4209d4be2ea8f4863c4c19d96636fd308ea7c557206be86f92c56` |
| GMP 6.2.1 | https://ftp.gnu.org/gnu/gmp/gmp-6.2.1.tar.xz | | `fd4829912cddd12f84181c3451cc752be224643e87fac497b69edddadc49b4f2` |
| MPFR 4.1.0 | https://ftp.gnu.org/gnu/mpfr/mpfr-4.1.0.tar.xz | | `0c98a3f1732ff6ca4ea690552079da9c597872d30e96ec28414ee23c95558a7f` |
| MPC 1.2.1 | https://ftp.gnu.org/gnu/mpc/mpc-1.2.1.tar.gz | | `17503d2c395dfcf106b622dc142683c1199431d095367c6aacba6eec30340459` |

**Newlib-Header für configure:**
- GCCs configure liest die Ziel-Header (`--with-headers`), wie crosstool-NG auch.
- Sie kommen aus Espressifs Binär-Release derselben Toolchain:
  - `https://github.com/espressif/crosstool-NG/releases/download/esp-2021r2-patch5/<ziel>-gcc8_4_0-esp-2021r2-patch5-linux-amd64.tar.gz`
  - Daraus wird nur `<ziel>/<ziel>/include` entpackt.

| Ziel | SHA-256 (aus `crosstool-NG-esp-2021r2-patch5-checksum.sha256`) |
|---|---|
| xtensa-esp32-elf | `8ef14e0409c2011b41e504a30f70d3e35287313a795d1f2462ad2cd0e2052d37` |
| xtensa-esp32s3-elf | `8aa17a6adf01efa5b1628c8ac578063a44d26ae9581d39486b92223a41ef262f` |
| riscv32-esp-elf | `f7d73e5f9e2df3ea6ca8e2c95d6ca6d23d6b38fd101ea5d3012f3cb3cd59f39f` |

Abgleich mit den PlatformIO-Paketen:
- Die newlib-Header sind identisch.
- Bei riscv weichen nur die libstdc++-`c++config.h` des darwin-Pakets in drei `_GLIBCXX_USE_*`-Zeilen ab. Für configure ist das egal.

**Eigener Patch:** `patches/gcc-8-pch-emscripten.patch`, nur `gcc/config/host-linux.c`.
- GCC 8 kann einen PCH nicht relozieren.
- wasm32 hat kein mmap an fester Adresse.
- Der Patch reserviert deshalb beim Start eine 96-MiB-Arena. Sie wird freigegeben, wenn kein PCH geladen wird.

**configure (GCC):** Die Flags sind die aus `<ziel>-gcc -v` des nativen Pakets.
```
--host=i686-pc-linux-gnu --target=<ziel> --with-local-prefix=<prefix>/<ziel>
--with-headers=<prefix>/<ziel>/include --with-newlib --enable-threads=no --disable-shared
[--with-arch=rv32gc --with-abi=ilp32]
--with-pkgversion='crosstool-NG esp-2021r2-patch5' --disable-__cxa_atexit
--enable-cxx-flags=-ffunction-sections --disable-libgomp --disable-libmudflap --disable-libmpx
--disable-libssp --disable-libquadmath --disable-libquadmath-support --disable-libstdcxx-verbose
--without-isl --disable-lto --disable-plugin --enable-target-optspace --without-long-double-128
--disable-nls --enable-multiarch --enable-languages=c,c++ --enable-threads=posix
--enable-gcov-custom-rtio --enable-libstdcxx-time=yes --disable-bootstrap --enable-checking=release
--with-as=<native as> --with-ld=<native ld>   (+ *_FOR_TARGET = native objdump/readelf/nm/as/ld)
```
- Abweichungen vom nativen Paket: `--disable-lto --disable-plugin --without-isl`, dazu Prefix und Host.
- Am erzeugten Code ändert das nichts; das ist byte-genau geprüft.
- Native Ziel-binutils derselben Quelle sind **nötig** und werden nicht ausgeliefert. Ohne sie fällt configure still auf ältere Assembler-Features zurück, und die Objekte weichen ab.

**configure (binutils, wasm):**
```
--host=i686-pc-linux-gnu --target=<ziel> --disable-nls --disable-werror --disable-shared
--disable-plugins --disable-gdb --disable-sim --disable-gprof --disable-readline
--disable-libdecnumber --without-zlib --with-pkgversion='crosstool-NG esp-2021r2-patch5'
```

## esp32-v3 / esp32s3-v3 / riscv32-v3: `toolchains/esp14/` (Dockerfile + build.sh)

Für Arduino-ESP32 3.x: pioarduino `platform-espressif32` 55.03.39 (Arduino-ESP32 3.3.9, ESP-IDF 5.5.4).

| id | Ziel | Chip-Konfiguration | Boards | passt zu |
|---|---|---|---|---|
| esp32-v3 | `xtensa-esp-elf` | `xtensa_esp32` eingebaut | esp32dev | `toolchain-xtensa-esp-elf@14.2.0+20260121` |
| esp32s3-v3 | `xtensa-esp-elf` | `xtensa_esp32s3` eingebaut | esp32-s3-devkitc-1, arduino_nano_esp32 | `toolchain-xtensa-esp-elf@14.2.0+20260121` |
| riscv32-v3 | `riscv32-esp-elf` | – (`--with-arch=rv32gc --with-abi=ilp32`) | esp32-c3-devkitm-1, esp32-c6-devkitc-1 | `toolchain-riscv32-esp@14.2.0+20260121` |

- **Bauvorschrift:**
  - Repo: [espressif/crosstool-NG](https://github.com/espressif/crosstool-NG)
  - Tag: `esp-14.2.0_20260121`, Commit `83e0002aad6dff93c69707a7b85c8d152f1b17c9`
  - Datei: `samples/{xtensa,riscv32}-esp-elf/crosstool.config`
  - Submodul `overlays` = xtensa-overlays `dd1cf19`
- crosstool-NG wendet auf Git-Quellen keine Patches an.

| Quelle | URL | Tag / Commit | SHA-256 des Archivs |
|---|---|---|---|
| GCC 14.2.0 (Espressif) | https://github.com/espressif/gcc/archive/refs/tags/esp-14.2.0_20260121.tar.gz | `esp-14.2.0_20260121` / `31cc3830ae24a75e7da1628bdfb07e766fd3ebd1` | `a1047d04f01cc21e6fe372d2e82092dab8bb89516e071ab2abae7a7f7202edd7` |
| binutils 2.43.1 (Espressif) | https://github.com/espressif/binutils-gdb/archive/refs/tags/esp-2.43.1_20260121.tar.gz | `esp-2.43.1_20260121` / `0022556a8e1a345ce5a2138076d03b1500ed8896` | `a2ecd29ce6f80ab36981883b3106279984cda6767caa636bf487cf5e64c04758` |
| xtensa-overlays | https://github.com/espressif/xtensa-overlays/archive/dd1cf19f6eb327a9db51043439974a6de13f5c7f.tar.gz | `dd1cf19f6eb327a9db51043439974a6de13f5c7f` | `2ff44e3932c4209d4be2ea8f4863c4c19d96636fd308ea7c557206be86f92c56` |
| GMP 6.3.0 | https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz | | `a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898` |
| MPFR 4.2.1 | https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.1.tar.xz | | `277807353a6726978996945af13e52829e3abd7a9a5b7fb2793894e18f1fcbb2` |
| MPC 1.3.1 | https://ftp.gnu.org/gnu/mpc/mpc-1.3.1.tar.gz | | `ab642492f5cf882b74aa0cb730cd410a81edcdbec895183ce930e706c1c759b8` |

**Newlib-Header für configure:** Sie kommen aus Espressifs Binär-Release
`<ziel>-14.2.0_20260121-x86_64-linux-gnu.tar.xz`; daraus wird nur `<ziel>/<ziel>/include` entpackt.
- xtensa: `da31f36d79d4e99f24e55a90a71e65d5694714f16199960bf7885724b706a48c`
- riscv32: `b3fce4b04dd15a9f0ed1c209b5a2f389c04eff92ed85e4cc0ebc275b7d95e95a`

**dynconfig (nur Xtensa).**
- Der native `xtensa-esp-elf` ist ein Compiler für alle Chips. Der Wrapper `xtensa-esp32-elf-g++`
  gibt `-mdynconfig=xtensa_esp32.so` an `cc1plus` und `--dynconfig=xtensa_esp32.so` an `as` und
  `ld`. Die Tools laden die Chip-Konfiguration per `dlopen()`; wasm kann das nicht.
- Daher gibt es einen Build pro Chip. Die Overlay-Dateien kommen in die Quellen:
  `include/xtensa-config.h` in gcc und binutils, dazu `bfd/xtensa-modules.c`. Genau daraus baut
  `xtensa-dynconfig` die native `.so`.
- GCC und bfd werden ohne Plugin-Unterstützung gebaut und nehmen dann die eingebaute Konfiguration.
- **Eigene Patches** `patches/gcc-14-xtensa-static-dynconfig.patch` und
  `patches/binutils-2.43-xtensa-static-dynconfig.patch`:
  - `-mdynconfig=`/`--dynconfig=` werden angenommen, wenn sie genau den eingebauten Chip nennen
    (`XTENSA_STATIC_DYNCONFIG` in der kopierten `xtensa-config.h`). Ein anderer Chip ist ein Fehler.
  - Die vordefinierten `__XCHAL_*`-Makros sind die der nativen `.so` (Konfig v1–v3).
- **Der Treiber lässt `-mdynconfig=`/`--dynconfig=` in den Kommandozeilen stehen.** GCC schreibt die
  Option in `DW_AT_producer`; Herausfiltern würde das `.o` ändern.

**Eigener Patch** `patches/gcc-14-pch-emscripten.patch` (`gcc/config/host-linux.cc`):
- Die Linux-Hooks scheitern unter Emscripten mit „PCH allocation failure“.
- GCC ≥ 12 reloziert ein PCH an einer anderen Adresse. Der Patch besorgt daher nur einen
  64-KiB-ausgerichteten Block. Eine Arena wie bei GCC 8 ist nicht mehr nötig.

**configure (GCC):** Die Flags sind die aus `<ziel>-gcc -v` des Pakets.
```
--host=i686-pc-linux-gnu --target=<ziel> --prefix=<p> --exec_prefix=<p> --with-local-prefix=<p>/<ziel>
--with-sysroot=<p>/<ziel> --with-native-system-header-dir=/include --with-headers=<p>/<ziel>/include
--with-newlib --enable-threads=no --disable-shared [--with-arch=rv32gc --with-abi=ilp32]
--with-pkgversion='crosstool-NG esp-14.2.0_20260121' --disable-__cxa_atexit
--enable-cxx-flags='-ffunction-sections -fdata-sections' --disable-libgomp --disable-libmudflap
--disable-libmpx --disable-libssp --disable-libquadmath --disable-libquadmath-support
--disable-libstdcxx-verbose --without-isl --without-zstd --disable-lto --enable-target-optspace
--without-long-double-128 --disable-plugin --disable-nls --enable-multiarch --enable-languages=c,c++
--enable-threads=posix --enable-libstdcxx-time=yes --disable-bootstrap --enable-checking=release
--with-as=<native as> --with-ld=<native ld>   (+ *_FOR_TARGET = native objdump/readelf/nm/as/ld)
```
- Abweichungen vom Paket:
  - `--disable-lto --without-isl --without-zstd`
  - Xtensa: `--disable-plugin` (nativ `--enable-plugin`, nur für dynconfig)
  - Prefix und Host
- Native Ziel-binutils derselben Quellen sind nötig, nur für configure.
- riscv32 linkt mit `-sINITIAL_MEMORY=32MB`. `cc1*` braucht mehr als die 16 MB Startspeicher von
  Emscripten; bei Xtensa bleibt es beim Standard.

**configure (binutils, wasm):** wie crosstool-NG (`--with-sysroot`, `--enable-multilib`,
`--with-pkgversion`), dazu `--disable-shared --disable-plugins --without-zlib --without-zstd
--disable-gdb --disable-sim --disable-gprof --disable-gprofng --disable-readline`.

## esp8266: `toolchains/esp8266/` (Dockerfile + build.sh)

Passt zu PlatformIO `toolchain-xtensa@2.100300.220621` (espressif8266@4.2.1, Arduino ESP8266 3.1.2).

- Ziel `xtensa-lx106-elf`, GCC 10.3.0, binutils 2.32.
- Das PlatformIO-Paket ist dateigleich zu earlephilhowers Release `3.1.0-gcc10.3`
  (`x86_64-linux-gnu.xtensa-lx106-elf-e5f9fec.220621`). Gebaut wurde es vom Makefile von
  [esp-quick-toolchain](https://github.com/earlephilhower/esp-quick-toolchain) im Commit
  `e5f9fec6c7fa8399c52015eea27f0836f8cccfe9`.
- Der GitHub-Tag `3.1.0-gcc10.3` zeigt auf den Vorgänger `8903880f`. Er unterscheidet sich in einer
  Zeile von `gcc-xtensa-0007` (`result[64]` statt `[128]`).
- Die lx106-Konfiguration ist fest eingebaut, ohne dynconfig: `include/xtensa-config.h` von gcc und
  binutils wird aus lx106-hal `core-isa.h` + `system.h` + vier `XCHAL_HAVE_FP_* 0` erzeugt.
  `bfd/xtensa-modules.c` bleibt upstream. Das ist das Makefile-Ziel `.stage.patch`.

| Quelle | URL | SHA-256 |
|---|---|---|
| GCC 10.3.0 (= Tag `releases/gcc-10.3.0`) | https://ftp.gnu.org/gnu/gcc/gcc-10.3.0/gcc-10.3.0.tar.xz | `64f404c1a650f27fc33da242e1f2df54952e3963a49e06e73f6940f3223ac344` |
| binutils-gdb 2.32 (Tag `binutils-2_32`, `a9d9a104dde6a749f40ce5c4576a0042a7d52d1f`) | https://github.com/gnutools/binutils-gdb/archive/a9d9a104dde6a749f40ce5c4576a0042a7d52d1f.tar.gz | `2c8f4f05070eb3799193203cc7ef491117dfa8b681a695481954b38feabdd934` |
| esp-quick-toolchain (Patches) | https://github.com/earlephilhower/esp-quick-toolchain/archive/e5f9fec6c7fa8399c52015eea27f0836f8cccfe9.tar.gz | `25cbf94ace3144bf073760b21b16208ba56dccd593ce38cda442133687589f67` |
| lx106-hal | https://github.com/earlephilhower/lx106-hal/archive/e4bcc63c9c016e4f8848e7e8f512438ca857531d.tar.gz | `f61acf7dd0e32c5cab6ce38d3cab10f5fe366454288b74b4ee16182f45b6bc24` |
| GMP 6.1.0 | https://gcc.gnu.org/pub/gcc/infrastructure/gmp-6.1.0.tar.bz2 | `498449a994efeba527885c10405993427995d3f86b8768d8cdf8d9dd7c6b73e8` |
| MPFR 3.1.4 | https://gcc.gnu.org/pub/gcc/infrastructure/mpfr-3.1.4.tar.bz2 | `d3103a80cdad2407ed581f3618c4bed04e0c92d1cf771a65ead662cc397f7775` |
| MPC 1.0.3 | https://gcc.gnu.org/pub/gcc/infrastructure/mpc-1.0.3.tar.gz | `617decc6ea09889fb08ede330917a00b16809b8db88c29c31bfbb49cbf88ecc3` |

**Patches:**
- Upstream, in der Glob-Reihenfolge des Makefiles:
  - gcc: `patches/gcc-001-jump-tables-in-text-section-earlephilhower.patch`, dann 18 × `patches/gcc10.3/gcc-*.patch`
  - binutils: `patches/bin-001-hal.patch` (betrifft nur `gdb/`)
- Eigener Patch: `patches/gcc-10-pch-emscripten.patch`. Er ist gleich `gcc-8-pch-emscripten.patch`,
  denn GCC 10 kann ein PCH noch nicht relozieren.

**configure** (gcc und binutils, Liste des Makefiles, ohne `--with-pkgversion` → „(GCC)“):
```
--target=xtensa-lx106-elf --disable-shared --with-newlib --enable-threads=no --disable-__cxa_atexit
--disable-libgomp --disable-libmudflap --disable-nls --disable-multilib --disable-bootstrap
--enable-languages=c,c++ --enable-static=yes --disable-libstdcxx-verbose
```
- Abweichungen: `--disable-lto --disable-plugin --without-isl`, Prefix und Host.
- Wie bei allen Zielen kommen native binutils derselben Quelle für configure dazu.
- GCC sieht beim configure keine Ziel-Header, wie beim zweistufigen Original-Build: Stufe 1 wird
  vor newlib konfiguriert und nicht neu konfiguriert.
- `ld` 2.32 braucht keine Funktionszeiger-Emulation; gas keinen Patch.

## Prüfung esp32-v3 / esp32s3-v3 / riscv32-v3 / esp8266 (19.11.2026)

- **Boards:**
  - esp32dev, esp32-s3-devkitc-1, esp32-c3-devkitm-1, esp32-c6-devkitc-1 mit pioarduino 55.03.39
  - nodemcuv2 mit espressif8266@4.2.1
  - Je Board Blink und ein WiFi-Sketch.
- **Kommandozeilen:** `pio run -v`, dann `g++ … -###`, dann `spike/esp32-v3/extract-manifest.mjs`
  (für GCC 10 und GCC 14).
- **Skripte in `spike/esp32-v3/`:**
  - `compare.sh`: `.s`, `.o`, `.elf`, Image; nativer Lauf mit denselben Argumenten
  - `check-c-and-macros.sh`: `cc1` auf einer `.c` des Kerns und `cc1plus -E -dM`
  - `pch-check.sh`: wasm-`.gch` gegen natives `.gch` vom selben Pfad
- Geprüft wird die Ausgabe der Dockerfiles in `.build/toolchains/<id>`.

| id | Board | .s / .o / .elf / Image (Blink, WiFi) | cc1 `.c` | `-E -dM` | PCH (wasm / nativ) |
|---|---|---|---|---|---|
| esp32-v3 | esp32dev | identisch | identisch | identisch (14 289) | 38,8 / 54,1 MB, identisch |
| esp32s3-v3 | esp32-s3-devkitc-1 | identisch | identisch | identisch (15 825) | 39,4 / 54,9 MB, identisch |
| riscv32-v3 | esp32-c3-devkitm-1 | identisch | identisch | identisch (10 853) | 41,9 / 57,7 MB, identisch |
| riscv32-v3 | esp32-c6-devkitc-1 | identisch | identisch | identisch (11 859) | 42,4 / 58,0 MB, identisch |
| esp8266 | nodemcuv2 | identisch (Image: `elf2bin.py` 3.1.2) | identisch | identisch (3 716) | 18,1 / 28,3 MB, identisch |

- Images:
  - ESP32: esptool 5.3.0 `elf2image --flash-mode dio --flash-freq 40m|80m --flash-size 4MB|8MB --elf-sha256-offset 0xb0`
  - ESP8266: `elf2bin.py` mit eboot, DIO, 40 MHz, 4M
- **PCH:** Der Header-Pfad beim Erzeugen landet in den Debug-Infos (`.file`). Ein PCH aus einem
  anderen Verzeichnis ergibt ein anderes `.s`. Das PCH also vom selben Pfad erzeugen, den später
  `-include` nennt.

**Zeiten:**
- Messbedingungen: Node 25, Apple Silicon, Last 6–12 durch andere Prozesse, also nur grob.
- Der Link läuft über volle Archive per NODEFS, ohne Lazy-Linking.

| id | Sketch | warm cc1plus | warm ld | warm gesamt | kalt gesamt | mit PCH warm cc1plus |
|---|---|---|---|---|---|---|
| esp32-v3 | Blink | 1,5 s | 1,3 s | 2,9 s | 4,3 s | |
| esp32-v3 | WiFi | 2,4 s | 2,0 s | 4,5 s | 5,2 s | 1,3 s |
| esp32s3-v3 | WiFi | 2,7 s | 1,8 s | 4,6 s | 5,9 s | 1,9 s |
| riscv32-v3 (C3) | WiFi | 3–6 s | 1,4 s | 4–8 s | 6,0 s | 2,9 s |
| riscv32-v3 (C6) | WiFi | 3,2 s | 1,0 s | 4,2 s | 8,9 s | 1,8 s |
| esp8266 | WiFi | 0,39 s | 0,22 s | 0,63 s | 1,2 s | 0,19 s |

- Nativ unter derselben Last (esp32dev WiFi): `cc1plus` 0,7–1,0 s, `ld` 2,4–2,7 s.
- Spitzenspeicher: `cc1plus` 114–164 MiB, `ld` bis 207 MiB (ESP32) bzw. 28 MiB (ESP8266).

## Prüfung (18.11.2026)

- **Boards:** Blink für esp32dev, esp32-s3-devkitc-1 und esp32-c3-devkitm-1, espressif32@7.1.3.
- **Kommandozeilen:** aus `g++ -###` des nativen Treibers (`spike/esp32/extract-manifest.mjs <compile> <link> <pkgs> <board>`).
- **Ablauf:** wasm-Lauf mit `spike/esp32/compile.mjs`, Vergleich mit `spike/esp32/compare.sh`; der zeigt `.s`, `.o`, `firmware.elf` und das App-Image mit `esptool elf2image`.
- **PCH:** `Arduino.h`-PCH vom wasm-`cc1plus` erzeugen und damit kompilieren.

| id | .s / .o / .elf / Image vs. nativ | PCH (Größe, Ergebnis) |
|---|---|---|
| avr | `.wasm` bitgleich zu Phase 0 (38/38 `.o`, `.hex` identisch) | – |
| esp32 | identisch; `.wasm` bitgleich zu Phase 0 | 20,8 MB, `.o`/`.elf` identisch |
| esp32s3 | identisch | 22,8 MB, `.o`/`.elf` identisch |
| esp32c3 | identisch | 21,8 MB, `.o`/`.elf` identisch |

- Gegen `pio run` selbst unterscheiden sich die Images in 65 Byte.
- Das sind nur der ELF-SHA-256 bei 0xb0, die Prüfsumme und der angehängte Image-Hash. Ursache sind Debug-Pfade (siehe `spike/esp32/FINDINGS.md`).

## -O2 oder -O3

Gemessen an esp32 Blink: `wasm-opt -O3` als Nachlauf auf das `-O2`-`cc1plus.wasm` ergibt
12,22 statt 12,25 MB (−0,2 %). Die Ausgabe ist identisch.

Die Laufzeit war unter Last 43–47 nicht belastbar messbar:
- `-O2`: 10–44 s je Lauf
- `+O3`: 10–22 s je Lauf
- Die Werte streuen stark; auf einer ruhigen Maschine wären es 3–4 s.

Ein kompletter Bau mit `--build-arg OPT=-O3` wurde abgebrochen. `OPT` steckt auch in den
`LDFLAGS`, also läuft binaryen `-O3` auf jedem configure-Testprogramm; schon `configure` der
binutils dauerte damit über 40 min. Für einen späteren Versuch `-O3` nur beim Link von
`cc1`/`cc1plus` setzen.

**Entscheidung: `-O2` bleibt.** Auf einer ruhigen Maschine neu messen.
