#!/usr/bin/env bash
# Regenerates test-fixtures from a PlatformIO install (atmelavr@5.3.0, pioarduino 55.03.39 =
# Arduino-ESP32 3.3.9, espressif8266@4.2.1).
# Usage: scripts/generate-fixtures.sh [workdir]
#
# Run it in the pio-image (pack/pio-image), so the fixtures carry /opt/pio/... paths and not the
# build machine's home directory:
#   docker run --rm -u 0 -v "$PWD:/src" -w /src arduino-wasm-pio scripts/generate-fixtures.sh /work
# On a host it uses ~/.platformio (or PLATFORMIO_CORE_DIR / PLATFORMIO_PACKAGES_DIR / PIO / PIO_PYTHON).
#
# - sketches/<name>/       source sketches built natively with `pio run`
# - <board>/<sketch>/       firmware.elf (debug-stripped to stay small and free of build paths),
#                           the reference outputs made by the pinned tools from exactly that ELF
#                           (pio's firmware.hex / esptool 5.3.0 elf2image / elf2bin.py), `size -A -d`,
#                           pio's size line
# - hex/{ext,seg}           uno/blink moved to load addresses past 64 KiB (extended segment /
#                           linear address records), .hex by avr-objcopy -O ihex -R .eeprom
# - ino/<case>/             .ino inputs + expected.cpp from PlatformIO's own InoToCPPConverter
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$HERE/test-fixtures"
WORK="${1:-$(mktemp -d)}"
CORE="${PLATFORMIO_CORE_DIR:-$HOME/.platformio}"
PK="${PLATFORMIO_PACKAGES_DIR:-$CORE/packages}"
if [ -x "$CORE/penv/bin/pio" ]; then
  PIO="${PIO:-$CORE/penv/bin/pio}"
  PY="${PIO_PYTHON:-$CORE/penv/bin/python}"
else # pio-image: PlatformIO installed into the system python
  PIO="${PIO:-pio}"
  PY="${PIO_PYTHON:-python3}"
fi
# esptool 5.3.0 (pioarduino's penv; `esptool` on PATH otherwise)
ESPTOOL="$CORE/penv/bin/esptool"; [ -x "$ESPTOOL" ] || ESPTOOL=esptool
PIOARDUINO=https://github.com/pioarduino/platform-espressif32/releases/download/55.03.39/platform-espressif32.zip
export PLATFORMIO_SETTING_ENABLE_TELEMETRY=No

# board id : pio board : toolchain prefix : esptool chip : flash freq : flash size
BOARDS=(
  "uno:uno:toolchain-atmelavr/bin/avr:::"
  "esp32dev:esp32dev:toolchain-xtensa-esp-elf/bin/xtensa-esp32-elf:esp32:40m:4MB"
  "esp32-s3:esp32-s3-devkitc-1:toolchain-xtensa-esp-elf/bin/xtensa-esp32s3-elf:esp32s3:80m:8MB"
  "esp32-c3:esp32-c3-devkitm-1:toolchain-riscv32-esp/bin/riscv32-esp-elf:esp32c3:80m:4MB"
  "esp32-c6:esp32-c6-devkitc-1:toolchain-riscv32-esp/bin/riscv32-esp-elf:esp32c6:80m:8MB"
  "nodemcuv2:nodemcuv2:toolchain-xtensa/bin/xtensa-lx106-elf:esp8266:40:4M"
)

build() { # sketch board pioBoard platform
  local sketch=$1 board=$2 pioboard=$3 platform=$4
  local proj="$WORK/$sketch"
  mkdir -p "$proj/src"
  cp "$FIX/sketches/$sketch/"* "$proj/src/"
  cat > "$proj/platformio.ini" <<INI
[platformio]
src_dir = src

[env:$board]
platform = $platform
board = $pioboard
framework = arduino
lib_ldf_mode = chain
INI
  # pioarduino's `pio run -v` crashes after the link (SCons TypeError printing elf2image): no -v there
  local v=-v; [ "$platform" = "$PIOARDUINO" ] && v=
  (cd "$proj" && "$PIO" run -e "$board" $v > "$proj/$board.log" 2>&1)
}

for spec in "${BOARDS[@]}"; do
  IFS=: read -r board pioboard tc chip freq fsize <<<"$spec"
  for sketchdir in "$FIX/sketches"/*/; do
    sketch=$(basename "$sketchdir")
    # Sketches named avr-* only build for AVR, esp-* only for ESP32.
    case "$sketch:$board" in avr-*:esp*|avr-*:node*|esp-*:uno|esp-*:node*) continue ;; esac
    case "$board" in uno) platform=atmelavr@5.3.0 ;; nodemcuv2) platform=espressif8266@4.2.1 ;; *) platform=$PIOARDUINO ;; esac
    echo "== $board / $sketch"
    build "$sketch" "$board" "$pioboard" "$platform"
    B="$WORK/$sketch/.pio/build/$board"
    OUT="$FIX/$board/$sketch"
    mkdir -p "$OUT"
    grep -E '^(RAM|Flash):' "$WORK/$sketch/$board.log" > "$OUT/pio-size.txt"
    "$PK/$tc-strip" --strip-debug -o "$OUT/firmware.elf" "$B/firmware.elf"
    if [ "$board" = uno ]; then
      cp "$B/firmware.hex" "$OUT/firmware.hex"
    elif [ "$chip" = esp8266 ]; then
      # elf2bin.py output as pio wrote it (elf2bin reads only loaded sections: stripping changes nothing)
      cp "$B/firmware.elf" "$OUT/firmware.elf"; cp "$B/firmware.bin" "$OUT/firmware.bin"
    else
      # Exactly the flags pioarduino's builder passes (board JSON, builder/main.py ElfToBin).
      "$ESPTOOL" --chip "$chip" elf2image --flash-mode dio --flash-freq "$freq" --flash-size "$fsize" \
        --elf-sha256-offset 0xb0 -o "$OUT/firmware.bin" "$OUT/firmware.elf" > /dev/null
    fi
    # relative path: the first line of `size -A` names the file
    (cd "$OUT" && "$PK/$tc-size" -A -d firmware.elf > size-A.txt)
  done
done

# HEX with extended segment (seg: .text across 0x10000) and extended linear (ext: past 1 MiB,
# with a start address) records, from uno/blink.
AVR="$PK/toolchain-atmelavr/bin/avr"
mkdir -p "$FIX/hex"
"$AVR-objcopy" --change-section-lma .text=0x123458 --change-section-lma .data=0x8000 --set-start 0x123458 \
  "$FIX/uno/blink/firmware.elf" "$FIX/hex/ext.elf"
"$AVR-objcopy" --change-section-lma .text=0x1fff8 --change-section-lma .data=0x2f000 \
  "$FIX/uno/blink/firmware.elf" "$FIX/hex/seg.elf"
for n in ext seg; do "$AVR-objcopy" -O ihex -R .eeprom "$FIX/hex/$n.elf" "$FIX/hex/$n.hex"; done

# Bootloaders (no --elf-sha256-offset), as PlatformIO builds bootloader.bin.
# (the bootloader ELF name is the one in the board's pio log: bootloader_<mode>_<freq>.elf)
for spec in "esp32:esp32dev:40m:4MB:toolchain-xtensa-esp-elf/bin/xtensa-esp32-elf" \
            "esp32s3:esp32-s3:80m:8MB:toolchain-xtensa-esp-elf/bin/xtensa-esp32s3-elf" \
            "esp32c3:esp32-c3:80m:4MB:toolchain-riscv32-esp/bin/riscv32-esp-elf" \
            "esp32c6:esp32-c6:80m:8MB:toolchain-riscv32-esp/bin/riscv32-esp-elf"; do
  IFS=: read -r chip board freq fsize tc <<<"$spec"
  OUT="$FIX/bootloader/$chip"
  mkdir -p "$OUT"
  elf=$(grep -o "[^ ]*framework-arduinoespressif32-libs/$chip/bin/bootloader_[a-z0-9_]*\.elf" "$WORK/blink/$board.log" | head -1)
  "$PK/$tc-strip" --strip-debug -o "$OUT/bootloader.elf" "$elf"
  "$ESPTOOL" --chip "$chip" elf2image --flash-mode dio --flash-freq "$freq" --flash-size "$fsize" \
    -o "$OUT/bootloader.bin" "$OUT/bootloader.elf" > /dev/null
done
mkdir -p "$FIX/esp8266"
cp "$PK/framework-arduinoespressif8266/bootloaders/eboot/eboot.elf" "$FIX/esp8266/eboot.elf"

# .ino → .cpp through PlatformIO's converter (fixed temp path, so the output is stable).
for case in "$FIX/ino"/*/; do
  "$PY" "$HERE/scripts/pio-ino.py" "$PK/toolchain-atmelavr/bin/avr-g++" "$case" > "$case/expected.cpp"
done
echo "fixtures written to $FIX"
