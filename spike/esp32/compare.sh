#!/usr/bin/env bash
# Phase-0 spike: compare the wasm build against the native toolchain, byte for byte.
#
#   compare.sh <pio project> <sketch.cpp (relative to project)> <wasm out dir> [manifest]
#
# 1. native cc1plus/as via the gcc driver on the SAME source path and cwd → ref/<name>.o
#    (pio compiles a temp file, whose path lands in the debug info; the code is the same).
# 2. native ld with the manifest's ld line on ref .o → ref/firmware.elf
# 3. esptool elf2image (native, same flags as pio) on both ELFs → compare .bin
# 4. the wasm .bin against pio's own firmware.bin.
set -euo pipefail
PROJ=$(cd "$1" && pwd); SRC=$2; OUT=$(cd "$3" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
MANIFEST=${4:-$HERE/manifest.esp32dev.json}
PKG=${PIO_PACKAGES:-$HOME/.platformio/packages}
export PATH=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH
mf() { node -e 'const m=require(process.argv[1]); const v=m[process.argv[2]]; console.log(Array.isArray(v)?v.join(" "):v)' "$MANIFEST" "$1"; }
BOARD=$(mf board); TARGET=$(mf target); TCDIR=$(mf toolchainDir)
[ "$TARGET" = undefined ] && { BOARD=esp32dev; TARGET=xtensa-esp32-elf; TCDIR=toolchain-xtensa-esp32; }
ELF2IMAGE=$(mf elf2image)
PY=${PIO_PYTHON:-$HOME/.platformio/penv/bin/python}
ESPTOOL=$PKG/tool-esptoolpy/esptool.py
NAME=$(basename "$SRC")
cd "$PROJ"
mkdir -p ref

# 1+2: replay the manifest natively (same args, native binaries) so that only the binaries differ.
node - "$MANIFEST" "$PKG" "$SRC" "$PROJ/ref/$NAME.o" "$PROJ/ref/firmware.elf" "$BOARD" "$TARGET" "$TCDIR" <<'EOF' > ref/native-cmds.sh
const [manifest, PKG, SRC, OBJ, ELF, BOARD, TARGET, TCDIR] = process.argv.slice(2);
const m = JSON.parse(require("fs").readFileSync(manifest, "utf8"));
const v = { PKG, BUILD: `.pio/build/${BOARD}`, SRC, SRC_BASE: require("path").basename(SRC), ASM: "ref/sketch.s", OBJ, ELF };
const sub = (a) => a.map((x) => x.replace(/\$\{(\w+)\}/g, (_, k) => v[k]));
const q = (a) => a.map((x) => "'" + x.replace(/'/g, "'\\''") + "'").join(" ");
const tc = `${PKG}/${TCDIR}`;
console.log(`${tc}/libexec/gcc/${TARGET}/8.4.0/cc1plus ${q(sub(m.cc1plus))}`);
console.log(`${tc}/${TARGET}/bin/as ${q(sub(m.as))}`);
console.log(`${tc}/${TARGET}/bin/ld ${q(sub(m.ld))}`);
EOF
bash -e ref/native-cmds.sh

cmpf() { if cmp -s "$1" "$2"; then echo "  identical  $3"; else echo "  DIFFERENT  $3 ($(cmp -l "$1" "$2" 2>/dev/null | wc -l | tr -d ' ') bytes, sizes $(stat -f%z "$1") / $(stat -f%z "$2"))"; fi; }
img() { "$PY" "$ESPTOOL" $ELF2IMAGE -o "$2" "$1" >/dev/null; }

img ref/firmware.elf ref/firmware.bin
img "$OUT/firmware.elf" "$OUT/firmware.bin"
echo "wasm vs native toolchain (same command lines):"
cmpf ref/sketch.s "$OUT/sketch.s" "cc1plus output (.s)"
cmpf "ref/$NAME.o" "$OUT/$NAME.o" "object (.o)"
cmpf ref/firmware.elf "$OUT/firmware.elf" "firmware.elf"
cmpf ref/firmware.bin "$OUT/firmware.bin" "app image (.bin)"
echo "wasm vs pio run (pio compiled the .ino.cpp under a temp path):"
cmpf .pio/build/$BOARD/firmware.bin "$OUT/firmware.bin" "app image (.bin)"
# Without the ELF SHA-256 at 0xb0 (hash of the whole ELF incl. debug info), the image checksum
# byte and the appended SHA-256 of the image:
python3 - .pio/build/$BOARD/firmware.bin "$OUT/firmware.bin" <<'EOF'
import sys
a, b = (open(p, "rb").read() for p in sys.argv[1:3])
if len(a) != len(b): print("  sizes differ:", len(a), len(b)); sys.exit()
diff = [i for i in range(len(a)) if a[i] != b[i]]
outside = [i for i in diff if not (0xb0 <= i < 0xb0 + 32) and i < len(a) - 33]
print(f"  {len(diff)} differing bytes, {len(outside)} outside elf-sha256/checksum/image-hash")
EOF
