#!/usr/bin/env bash
# PCH check: Arduino.h → .gch with the wasm cc1plus, sketch compiled with it (-include), vs. the
# native cc1plus doing the same with its own .gch at the SAME path (the header path the PCH was
# made from ends up in the debug info, so both must be generated from the same path).
# Run compare.sh first (it writes ref/native-cmds.sh).
#
#   pch-check.sh <pio project> <wasm tools dir> <Arduino.h>
#   PIO_PACKAGES, DYNCONFIG as for compare.sh
set -euo pipefail
PROJ=$(cd "$1" && pwd); TOOLS=$(cd "$2" && pwd); HDR=$3; HERE=$(cd "$(dirname "$0")" && pwd)
PKG=${PIO_PACKAGES:-$HOME/.platformio/packages}
export PATH=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH
cd "$PROJ"
MF=$PROJ/manifest.json
TC=$PKG/$(node -e 'console.log(require(process.argv[1]).toolchainDir)' "$MF")
if [ -n "${DYNCONFIG:-}" ]; then export XTENSA_GNU_CONFIG=$TC/lib/$DYNCONFIG; fi
rm -rf pch ref-pch .wasm-pch; mkdir -p pch ref-pch; cp "$HDR" pch/Arduino.h

# wasm: generate, then compile + assemble + link with it
t0=$(date +%s)
PIO_PACKAGES=$PKG node "$HERE/../esp32/compile.mjs" --tools "$TOOLS" --project . --src src/main.ino.cpp --manifest "$MF" \
  --out .wasm-pch --gen-pch pch/Arduino.h pch/Arduino.h.gch | grep cc1plus
WSIZE=$(stat -f%z pch/Arduino.h.gch)
PIO_PACKAGES=$PKG node "$HERE/../esp32/compile.mjs" --tools "$TOOLS" --project . --src src/main.ino.cpp --manifest "$MF" \
  --obj .wasm-pch/main.ino.cpp.o --out .wasm-pch --pch pch/Arduino.h.gch --runs 3 | grep -E "cc1plus|total"
mv pch/Arduino.h.gch pch/wasm.gch

# native: the manifest's cc1plus line (from compare.sh) in header mode, then with -include
node - ref/native-cmds.sh "$PROJ" <<'EOF'
const fs = require("fs"); const [f, proj] = process.argv.slice(2);
const q = (a) => a.map((x) => "'" + x.replace(/'/g, "'\\''") + "'").join(" ");
const split = (l) => [...l.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]);
const [cc, as, ld] = fs.readFileSync(f, "utf8").trim().split("\n").map(split);
const re = (a) => a.map((x) => x.replace(`${proj}/ref/`, `${proj}/ref-pch/`));
const gen = cc.map((x, i) => x === "src/main.ino.cpp" ? "pch/Arduino.h" : x);
const o = gen.indexOf("-o");
const v11 = Number(JSON.parse(fs.readFileSync(`${proj}/manifest.json`, "utf8")).gccVersion.split(".")[0]) >= 11;
gen.splice(o, 2, "-o", "/tmp/npch.s", ...(v11 ? ["--output-pch", "pch/Arduino.h.gch"] : ["--output-pch=pch/Arduino.h.gch"]));
const use = re(cc); use.splice(1, 0, "-include", "pch/Arduino.h", "-Winvalid-pch");
fs.writeFileSync(`${proj}/ref-pch/cmds.sh`, [q(gen), q(use), q(re(as)), q(re(ld))].join("\n") + "\n");
EOF
bash -e ref-pch/cmds.sh
NSIZE=$(stat -f%z pch/Arduino.h.gch)
mv pch/wasm.gch pch/Arduino.h.gch
echo "PCH: wasm $WSIZE bytes, native $NSIZE bytes"
for f in sketch.s main.ino.cpp.o firmware.elf; do
  if cmp -s ref-pch/$f .wasm-pch/$f; then echo "  identical  $f (with PCH)"; else echo "  DIFFERENT  $f (with PCH)"; fi
done
