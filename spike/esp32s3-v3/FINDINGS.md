# esp32s3-v3 (Xtensa ESP32-S3, GCC 14) im Browser-Compiler: Ergebnisse

Stand 19.11.2026. **Ergebnis: Go.** Kurzfassung von `toolchains/README.md`.

## Was gebaut wird
- Wie `esp32-v3` (GCC 14.2.0, binutils 2.43.1, crosstool-NG `esp-14.2.0_20260121`), aber mit der
  eingebauten Chip-Konfiguration `xtensa_esp32s3` aus xtensa-overlays `dd1cf19`.
- Boards: `esp32-s3-devkitc-1` und `arduino_nano_esp32` (Nano ESP32, Variante `arduino_nano_nora`).
- Bau: `docker buildx build --output type=local,dest=.build/toolchains/esp32s3-v3 --build-arg CHIP=esp32s3 toolchains/esp14`,
  21,3 min mit `JOBS=6` (Quellen und GMP aus dem Cache).

## dynconfig und PCH
- `-mdynconfig=xtensa_esp32s3.so` bzw. `--dynconfig=` bleiben in den Kommandozeilen; der wasm-Build
  nimmt nur seinen eingebauten Chip an.
- PCH vom selben Pfad erzeugen, den `-include` nennt; `--output-pch <datei>` als zwei Argumente.

## Prüfung (esp32-s3-devkitc-1)
- Blink und WiFi: `.s`, `.o`, `.elf`, Image byte-gleich zum nativen Toolchain. `cc1`-`.c` und
  `-E -dM` (15 825 Makros) identisch.
- PCH: 39,4 MB (wasm) / 54,9 MB (nativ), identisch.
- Zeiten (Node, warm, WiFi): `cc1plus` 2,7 s (mit PCH 1,9 s), `ld` 1,8 s, gesamt 4,6 s.
- Größe: 39,35 MB roh, 9,89 MB Brotli.
