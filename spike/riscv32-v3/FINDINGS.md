# riscv32-v3 (RISC-V ESP32-C3/C6, GCC 14) im Browser-Compiler: Ergebnisse

Stand 19.11.2026. **Ergebnis: Go.** Kurzfassung von `toolchains/README.md`.

## Was gebaut wird
- Ziel `riscv32-esp-elf`, GCC 14.2.0, binutils 2.43.1 (crosstool-NG `esp-14.2.0_20260121`),
  `--with-arch=rv32gc --with-abi=ilp32`, kein dynconfig.
- Passt zu `toolchain-riscv32-esp@14.2.0+20260121` (pioarduino 55.03.39).
- Ein Build für beide Chips: `esp32-c3-devkitm-1` und `esp32-c6-devkitc-1`.
- Bau: `docker buildx build --output type=local,dest=.build/toolchains/riscv32-v3 --build-arg CHIP=riscv32 toolchains/esp14`,
  28,7 min kalt mit `JOBS=6`.
- `cc1*` braucht mehr als 16 MB Startspeicher: Link mit `-sINITIAL_MEMORY=32MB`.

## Treiber
- `-march` kommt pro Board: C3 `rv32imc_zicsr_zifencei`, C6 `rv32imac_zicsr_zifencei`, dazu das
  passende `-imultilib`. Auch `as` bekommt die `-I…` der Kommandozeile.
- PCH vom selben Pfad erzeugen, den `-include` nennt; `--output-pch <datei>` als zwei Argumente.

## Prüfung
- C3 und C6, Blink und WiFi: `.s`, `.o`, `.elf`, Image byte-gleich zum nativen Toolchain.
  `cc1`-`.c` identisch; `-E -dM` identisch (C3 10 853, C6 11 859 Makros).
- PCH: C3 41,9 / 57,7 MB, C6 42,4 / 58,0 MB (wasm / nativ), identisch.
- Zeiten (Node, warm, WiFi): C3 `cc1plus` 3–6 s (mit PCH 2,9 s), C6 3,2 s (mit PCH 1,8 s);
  `ld` 1,0–1,4 s.
- Größe: 77,54 MB roh, 13,24 MB Brotli, doppelt so groß wie die Xtensa-Builds (ohne `cc1`
  7,3 MB). Ursache: das RISC-V-Backend von GCC 14 mit den Vektor-Mustern (RVV) in `insn-*`.
