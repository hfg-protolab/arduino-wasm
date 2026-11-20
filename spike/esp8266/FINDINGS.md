# esp8266 (xtensa-lx106, GCC 10.3) im Browser-Compiler: Ergebnisse

Stand 19.11.2026. **Ergebnis: Go.** Kurzfassung von `toolchains/README.md`, Abschnitt „esp8266“.

## Was gebaut wird
- Ziel `xtensa-lx106-elf`, GCC 10.3.0, binutils 2.32. Passt zu
  `toolchain-xtensa@2.100300.220621` (espressif8266@4.2.1, Arduino ESP8266 3.1.2).
- Das PlatformIO-Paket ist dateigleich zu earlephilhowers Release `3.1.0-gcc10.3`, gebaut vom
  Makefile von esp-quick-toolchain im Commit `e5f9fec`. Achtung: der GitHub-Tag zeigt auf den
  Vorgänger `8903880f`, der sich in einer Zeile von `gcc-xtensa-0007` unterscheidet.
- Die lx106-Konfiguration ist fest eingebaut (kein dynconfig): `xtensa-config.h` aus lx106-hal.
- Patches: die 19 GCC-Patches und `bin-001-hal.patch` von esp-quick-toolchain, dazu
  `gcc-10-pch-emscripten.patch` (wie bei GCC 8: GCC 10 kann ein PCH noch nicht relozieren).
- Bau: `docker buildx build --output type=local,dest=.build/toolchains/esp8266 toolchains/esp8266`,
  10,7 min kalt mit `JOBS=6`.

## Prüfung (nodemcuv2)
- Blink und WiFi: `.s`, `.o`, `.elf` und Image (`elf2bin.py` 3.1.2) byte-gleich zum nativen
  Toolchain. `cc1`-`.c` und `-E -dM` (3 716 Makros) identisch.
- PCH: 18,1 MB (wasm) / 28,3 MB (nativ), identisch.
- Zeiten (Node, warm, WiFi): `cc1plus` 0,39 s (mit PCH 0,19 s), `ld` 0,22 s, gesamt 0,63 s.
  Spitzenspeicher `ld` 28 MiB.
- Größe: 28,93 MB roh, 7,59 MB Brotli.
