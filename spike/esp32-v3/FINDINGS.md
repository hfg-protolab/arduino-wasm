# esp32-v3 (Xtensa ESP32, GCC 14) im Browser-Compiler: Ergebnisse

Stand 19.11.2026. **Ergebnis: Go.** Kurzfassung von `toolchains/README.md`, Abschnitte „esp32-v3 /
esp32s3-v3 / riscv32-v3“ und „Prüfung … (19.11.2026)“.

## Was gebaut wird
- Ziel `xtensa-esp-elf`, GCC 14.2.0 und binutils 2.43.1 aus crosstool-NG `esp-14.2.0_20260121`.
- Passt zu `toolchain-xtensa-esp-elf@14.2.0+20260121` aus pioarduino 55.03.39
  (Arduino-ESP32 3.3.9, ESP-IDF 5.5.4). Board: `esp32dev`.
- Bau: `docker buildx build --output type=local,dest=.build/toolchains/esp32-v3 toolchains/esp14`,
  20,7 min kalt mit `JOBS=6`.

## dynconfig
- Der native Compiler lädt die Chip-Konfiguration per `dlopen()` (`-mdynconfig=xtensa_esp32.so`).
  WebAssembly kann das nicht.
- Deshalb ist die Konfiguration aus xtensa-overlays `dd1cf19` (`xtensa_esp32`) fest eingebaut, ein
  Build pro Chip.
- Eigene Patches (`gcc-14-xtensa-static-dynconfig.patch`, `binutils-2.43-xtensa-static-dynconfig.patch`):
  `-mdynconfig=`/`--dynconfig=` werden angenommen, wenn sie den eingebauten Chip nennen; ein anderer
  Chip ist ein Fehler.
- **Der Treiber filtert die Option nicht.** GCC schreibt sie in `DW_AT_producer`, ohne sie wäre das
  `.o` anders.

## PCH
- `gcc-14-pch-emscripten.patch`: GCC 14 reloziert PCHs, der Patch besorgt nur einen
  64-KiB-ausgerichteten Block.
- Der Header-Pfad beim Erzeugen landet im `.s`: das PCH vom selben Pfad erzeugen, den später
  `-include` nennt. `--output-pch <datei>` sind bei GCC 14 zwei Argumente.

## Prüfung
- Blink und WiFi: `.s`, `.o`, `.elf` und Image byte-gleich zum nativen Toolchain mit denselben
  Kommandozeilen. `cc1` auf einer `.c` und `cc1plus -E -dM` (14 289 Makros) identisch.
- PCH: 38,8 MB (wasm) / 54,1 MB (nativ), Ergebnis identisch.
- Zeiten (Node, warm, WiFi): `cc1plus` 2,4 s (mit PCH 1,3 s), `ld` 2,0 s, gesamt 4,5 s.
- Größe: 39,07 MB roh, 9,86 MB Brotli (alle vier Programme).

## Stolpersteine
- `pio run -v` (pioarduino 55.03.39) stürzt nach dem Link mit einem SCons-`TypeError` beim Drucken
  der `elf2image`-Zeile ab. Das ELF ist vollständig; das App-Image mit esptool 5.3.0
  `elf2image --elf-sha256-offset 0xb0` selbst erzeugen.
- pio löscht `src/main.ino.cpp` nach dem Build.
