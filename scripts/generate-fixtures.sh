#!/usr/bin/env bash
# Regenerates test-fixtures from a PlatformIO install (atmelavr@5.3.0, espressif32@7.1.3).
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
#                           (pio's firmware.hex / esptool.py elf2image), `size -A -d`, pio's size line
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
ESPTOOL="$PK/tool-esptoolpy/esptool.py"
export PLATFORMIO_SETTING_ENABLE_TELEMETRY=No

# board id : pio board : toolchain prefix : esptool chip : flash freq : flash size
BOARDS=(
  "uno:uno:toolchain-atmelavr/bin/avr:::"
  "esp32dev:esp32dev:toolchain-xtensa-esp32/bin/xtensa-esp32-elf:esp32:40m:4MB"
  "esp32-s3:esp32-s3-devkitc-1:toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf:esp32s3:80m:8MB"
  "esp32-c3:esp32-c3-devkitm-1:toolchain-riscv32-esp/bin/riscv32-esp-elf:esp32c3:80m:4MB"
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
  (cd "$proj" && "$PIO" run -e "$board" -v > "$proj/$board.log" 2>&1)
}

for spec in "${BOARDS[@]}"; do
  IFS=: read -r board pioboard tc chip freq fsize <<<"$spec"
  for sketchdir in "$FIX/sketches"/*/; do
    sketch=$(basename "$sketchdir")
    # Sketches named avr-* only build for AVR, esp-* only for ESP32.
    case "$sketch:$board" in avr-*:esp*|esp-*:uno) continue ;; esac
    if [ "$board" = uno ]; then platform=atmelavr@5.3.0; else platform=espressif32@7.1.3; fi
    echo "== $board / $sketch"
    build "$sketch" "$board" "$pioboard" "$platform"
    B="$WORK/$sketch/.pio/build/$board"
    OUT="$FIX/$board/$sketch"
    mkdir -p "$OUT"
    grep -E '^(RAM|Flash):' "$WORK/$sketch/$board.log" > "$OUT/pio-size.txt"
    "$PK/$tc-strip" --strip-debug -o "$OUT/firmware.elf" "$B/firmware.elf"
    if [ "$board" = uno ]; then
      cp "$B/firmware.hex" "$OUT/firmware.hex"
    else
      # Exactly the flags PlatformIO's espressif32 builder passes (see its -v log).
      "$PY" "$ESPTOOL" --chip "$chip" elf2image --flash_mode dio --flash_freq "$freq" --flash_size "$fsize" \
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
for spec in "esp32:esp32:bootloader_dio_40m:40m:4MB:toolchain-xtensa-esp32/bin/xtensa-esp32-elf" \
            "esp32c3:esp32c3:bootloader_qio_80m:80m:4MB:toolchain-riscv32-esp/bin/riscv32-esp-elf"; do
  IFS=: read -r chip sdk name freq fsize tc <<<"$spec"
  OUT="$FIX/bootloader/$chip"
  mkdir -p "$OUT"
  "$PK/$tc-strip" --strip-debug -o "$OUT/bootloader.elf" "$PK/framework-arduinoespressif32/tools/sdk/$sdk/bin/$name.elf"
  "$PY" "$ESPTOOL" --chip "$chip" elf2image --flash_mode dio --flash_freq "$freq" --flash_size "$fsize" \
    -o "$OUT/bootloader.bin" "$OUT/bootloader.elf" > /dev/null
done

# .ino → .cpp through PlatformIO's converter (fixed temp path, so the output is stable).
for case in "$FIX/ino"/*/; do
  "$PY" "$HERE/scripts/pio-ino.py" "$PK/toolchain-atmelavr/bin/avr-g++" "$case" > "$case/expected.cpp"
done
echo "fixtures written to $FIX"
