#!/usr/bin/env bash
# Two checks beyond compare.sh, wasm vs native with identical arguments:
#   1. cc1 (C): the first framework .c file of the pio build log → cc1 + as → .s / .o
#   2. predefined macros: the manifest's cc1plus line with -E -dM (catches a wrong compiled-in
#      chip configuration even where the sketch's code would not show it)
#
#   check-c-and-macros.sh <pio project (built with pio run -v > build.log)> <wasm tools dir>
#   TCBIN       native toolchain bin dir (the driver of the build log, for -###)
#   PIO_PACKAGES, DYNCONFIG as for compare.sh
set -euo pipefail
PROJ=$(cd "$1" && pwd); TOOLS=$(cd "$2" && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
PKG=${PIO_PACKAGES:-$HOME/.platformio/packages}
export PATH=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH
cd "$PROJ"; mkdir -p ref .wasm
if [ -n "${DYNCONFIG:-}" ]; then export XTENSA_GNU_CONFIG=$(dirname "$TCBIN")/lib/$DYNCONFIG; fi
cmpf() { if cmp -s "$1" "$2"; then echo "  identical  $3"; else echo "  DIFFERENT  $3"; fi; }

CMD=$(grep -E -m1 "^\S+-gcc -o \S+\.c\.o -c .* \S+\.c$" build.log)
PATH=$TCBIN:$PATH eval "$CMD -###" 2> ref/c.txt || true
# Writes ref/checks.sh: native and wasm runs of cc1, as (the .c file) and cc1plus -E -dM.
node - "$PROJ" "$PKG" "$TOOLS" "$HERE" <<'EOF' > ref/checks.sh
const [proj, PKG, tools, here] = process.argv.slice(2);
const fs = require("fs");
const split = (l) => [...l.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
const q = (a) => a.map((x) => "'" + x.replace(/'/g, "'\\''") + "'").join(" ");
const ls = fs.readFileSync(`${proj}/ref/c.txt`, "utf8").split("\n").filter((l) => l.startsWith(" ")).map(split);
const cc1 = ls.find((a) => a[0].endsWith("/cc1")), as = ls.find((a) => a[0].endsWith("/as"));
const dep = new Set(["-MMD", "-MF", "-MQ", "-MD"]);
const fix = (a, dir) => {
  const out = [];
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (dep.has(x)) { i++; continue; }
    if (/\/T\/\/?cc\w+\.s$/.test(x)) { out.push(`${dir}/c.s`); continue; }
    if (a[i - 1] === "-o" && x.endsWith(".o")) { out.push(`${dir}/c.o`); continue; }
    out.push(x);
  }
  return out;
};
const run = (tool, args, ...mounts) => `node ${q([`${here}/run-tool.mjs`, tools, tool, proj, ...mounts])} -- ${q(args)}`;
const src = cc1.find((x) => x.endsWith(".c"));
console.log(`echo 'cc1: ${src}'`);
console.log(`${q([cc1[0]])} ${q(fix(cc1, `${proj}/ref`))}`);
console.log(`${q([as[0]])} ${q(fix(as, `${proj}/ref`))}`);
console.log(run("cc1", fix(cc1, `${proj}/.wasm`), PKG, require("path").dirname(src)));
console.log(run("as", fix(as, `${proj}/.wasm`), PKG));
const m = require(`${proj}/manifest.json`);
const dm = (out) => {
  const a = [];
  for (let i = 0; i < m.cc1plus.length; i++) {
    const x = m.cc1plus[i];
    if (x === "-o") { a.push("-E", "-dM", "-o", out); i++; continue; }
    a.push(x.replace("${PKG}", PKG).replace("${SRC}", "src/main.ino.cpp").replace("${OBJ}", "x.o"));
  }
  return a;
};
console.log(`${q([`${PKG}/${m.toolchainDir}/libexec/gcc/${m.target}/${m.gccVersion}/cc1plus`])} ${q(dm(`${proj}/ref/macros.txt`))}`);
console.log(run("cc1plus", dm(`${proj}/.wasm/macros.txt`), PKG));
EOF
bash -e ref/checks.sh 2>&1 | grep -v '^\[' || true
cmpf ref/c.s .wasm/c.s "cc1 output (.s)"
cmpf ref/c.o .wasm/c.o "object (.o)"
echo "predefined macros: $(wc -l < ref/macros.txt | tr -d ' ') lines"
cmpf ref/macros.txt .wasm/macros.txt "cc1plus -E -dM"
