#!/usr/bin/env bash
# Toolchain spike (GCC 14 / GCC 10.3): compile + link a sketch with the wasm tools and with the
# native tools of the PlatformIO package, with the SAME command lines (the manifest from
# extract-manifest.mjs), and compare .s, .o and firmware.elf byte for byte.
#
#   compare.sh <pio project> <wasm tools dir> [manifest] [-- extra compile.mjs args]
#
#   PIO_PACKAGES   packages dir the manifest's ${PKG} stands for (default ~/.platformio/packages)
#   DYNCONFIG      xtensa-esp-elf only: chip .so for the NATIVE replay (the native tools dlopen it;
#                  the manifest's -mdynconfig=/--dynconfig= name only the file, the gcc wrapper
#                  normally sets XTENSA_GNU_CONFIG to its full path)
#   ELF2IMAGE      optional esptool elf2image args (e.g. "--chip esp32 elf2image --flash-mode dio
#                  --flash-freq 40m --flash-size 4MB --elf-sha256-offset 0xb0"): also compare images
set -euo pipefail
PROJ=$(cd "$1" && pwd); TOOLS=$(cd "$2" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
MANIFEST=${3:-$PROJ/manifest.json}
shift 3 2>/dev/null || shift $#
[ "${1:-}" = "--" ] && shift
PKG=${PIO_PACKAGES:-$HOME/.platformio/packages}
export PATH=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH
mf() { node -e 'const m=require(process.argv[1]); console.log(m[process.argv[2]])' "$MANIFEST" "$1"; }
TCDIR=$(mf toolchainDir); TARGET=$(mf target); VER=$(mf gccVersion)
TC=$PKG/$TCDIR
OUT=$PROJ/.wasm; REF=$PROJ/ref
rm -rf "$OUT" "$REF"; mkdir -p "$OUT" "$REF"
cd "$PROJ"

# 1. native replay: same args, native binaries → ref/
node - "$MANIFEST" "$PKG" "$REF" <<'EOF' > "$REF/native-cmds.sh"
const [manifest, PKG, REF] = process.argv.slice(2);
const m = JSON.parse(require("fs").readFileSync(manifest, "utf8"));
const v = { PKG, SRC: "src/main.ino.cpp", ASM: `${REF}/sketch.s`, OBJ: `${REF}/main.ino.cpp.o`, ELF: `${REF}/firmware.elf` };
const sub = (a) => a.map((x) => x.replace(/\$\{(\w+)\}/g, (_, k) => v[k]));
const q = (a) => a.map((x) => "'" + x.replace(/'/g, "'\\''") + "'").join(" ");
const tc = `${PKG}/${m.toolchainDir}`;
console.log(`${tc}/libexec/gcc/${m.target}/${m.gccVersion}/cc1plus ${q(sub(m.cc1plus))}`);
console.log(`${tc}/${m.target}/bin/as ${q(sub(m.as))}`);
console.log(`${tc}/${m.target}/bin/ld ${q(sub(m.ld))}`);
EOF
t0=$(date +%s)
if [ -n "${DYNCONFIG:-}" ]; then XTENSA_GNU_CONFIG=$TC/lib/$DYNCONFIG bash -e "$REF/native-cmds.sh"; else bash -e "$REF/native-cmds.sh"; fi
echo "native: $(( $(date +%s) - t0 )) s"

# 2. wasm
PIO_PACKAGES=$PKG node "$HERE/../esp32/compile.mjs" --tools "$TOOLS" --project "$PROJ" --src src/main.ino.cpp \
  --obj .wasm/main.ino.cpp.o --out "$OUT" --manifest "$MANIFEST" "$@" | grep -v '^{'

cmpf() { if cmp -s "$1" "$2"; then echo "  identical  $3"; else echo "  DIFFERENT  $3 ($(cmp -l "$1" "$2" 2>/dev/null | wc -l | tr -d ' ') bytes, sizes $(stat -f%z "$1") / $(stat -f%z "$2"))"; fi; }
echo "wasm vs native ($TARGET $VER, same command lines):"
cmpf "$REF/sketch.s" "$OUT/sketch.s" "cc1plus output (.s)"
cmpf "$REF/main.ino.cpp.o" "$OUT/main.ino.cpp.o" "object (.o)"
cmpf "$REF/firmware.elf" "$OUT/firmware.elf" "firmware.elf"
if [ -n "${ELF2IMAGE:-}" ]; then
  ESPTOOL=${ESPTOOL:-"$HOME/.platformio/penv/bin/python $HOME/.platformio/packages/tool-esptoolpy@src-29e975c43365633ad43cdaa0f5ec0b96/esptool.py"}
  $ESPTOOL $ELF2IMAGE -o "$REF/firmware.bin" "$REF/firmware.elf" >/dev/null
  $ESPTOOL $ELF2IMAGE -o "$OUT/firmware.bin" "$OUT/firmware.elf" >/dev/null
  cmpf "$REF/firmware.bin" "$OUT/firmware.bin" "app image (.bin)"
fi
