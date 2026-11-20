#!/usr/bin/env bash
# Espressif GCC 14.2.0 + binutils 2.43.1 (crosstool-NG esp-14.2.0_20260121) → WebAssembly.
# Builds only cc1, cc1plus, as and ld; no driver, no collect2, no LTO.
#
#   CHIP=esp32    xtensa-esp-elf,  chip config xtensa_esp32 compiled in   → .build/toolchains/esp32-v3
#   CHIP=esp32s3  xtensa-esp-elf,  chip config xtensa_esp32s3 compiled in → .build/toolchains/esp32s3-v3
#   CHIP=riscv32  riscv32-esp-elf  (esp32c3, esp32c6: -march/-mabi per board) → .build/toolchains/riscv32-v3
#
#   build.sh fetch-common | hostlibs | fetch-chip | binutils | native-binutils | gcc | out   (or: all)
#
# Sources = exactly what pioarduino's toolchain-xtensa-esp-elf / toolchain-riscv32-esp
# 14.2.0+20260121 were built from (crosstool-NG tag esp-14.2.0_20260121,
# samples/<target>/crosstool.config): see ../sources.json. crosstool-NG applies no patches to git
# sources.
#
# The native xtensa-esp-elf toolchain is ONE compiler for all Xtensa chips: the driver passes
# -mdynconfig=xtensa_<chip>.so (as/ld: --dynconfig=) and the tools dlopen() it. wasm has no
# dlopen, so this build compiles one chip in, like the pre-GCC-13 per-chip toolchains: the
# xtensa-overlays files of the chip go into the source tree (include/xtensa-config.h,
# bfd/xtensa-modules.c — the same files the native .so is built from), --disable-plugin makes
# GCC/bfd use them, and patches/*-xtensa-static-dynconfig.patch accept -mdynconfig= /
# --dynconfig= naming exactly that chip (so the native command lines work unchanged).
#
# Configure flags mirror `<target>-gcc -v` of the native package (prefix aside).
set -euo pipefail

CHIP=${CHIP:-esp32}
case "$CHIP" in
  esp32)   TARGET=xtensa-esp-elf;  OVERLAY=xtensa_esp32;   EXTRA_GCC_CONF=() ;;
  esp32s3) TARGET=xtensa-esp-elf;  OVERLAY=xtensa_esp32s3; EXTRA_GCC_CONF=() ;;
  # riscv: cc1/cc1plus static data + 8 MB stack exceed Emscripten's default 16 MB initial memory.
  riscv32) TARGET=riscv32-esp-elf; OVERLAY=;               EXTRA_GCC_CONF=(--with-arch=rv32gc --with-abi=ilp32)
           EXTRA_LDFLAGS=-sINITIAL_MEMORY=32MB ;;
  *) echo "unknown CHIP $CHIP (esp32 | esp32s3 | riscv32)"; exit 2 ;;
esac

CT_TAG=esp-14.2.0_20260121
GCC_TAG=esp-14.2.0_20260121                  # commit 31cc3830ae24a75e7da1628bdfb07e766fd3ebd1
GCC_SHA256=a1047d04f01cc21e6fe372d2e82092dab8bb89516e071ab2abae7a7f7202edd7
BINUTILS_TAG=esp-2.43.1_20260121             # commit 0022556a8e1a345ce5a2138076d03b1500ed8896
BINUTILS_SHA256=a2ecd29ce6f80ab36981883b3106279984cda6767caa636bf487cf5e64c04758
OVERLAYS_REV=dd1cf19f6eb327a9db51043439974a6de13f5c7f   # crosstool-NG submodule "overlays"
OVERLAYS_SHA256=2ff44e3932c4209d4be2ea8f4863c4c19d96636fd308ea7c557206be86f92c56
PKGVERSION="crosstool-NG ${CT_TAG}"
GMP_VERSION=6.3.0;  GMP_SHA256=a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898
MPFR_VERSION=4.2.1; MPFR_SHA256=277807353a6726978996945af13e52829e3abd7a9a5b7fb2793894e18f1fcbb2
MPC_VERSION=1.3.1;  MPC_SHA256=ab642492f5cf882b74aa0cb730cd410a81edcdbec895183ce930e706c1c759b8
# Espressif's binary release of the same toolchain. Only its target headers (newlib) are used:
# GCC's configure inspects them (--with-headers / --with-sysroot), as in crosstool-NG. Headers
# are host independent, so the linux-x86_64 archive serves every build host. Checksums from the
# release's crosstool-NG-esp-14.2.0_20260121-checksum.sha256.
case "$TARGET" in
  xtensa-esp-elf)  REL_SHA256=da31f36d79d4e99f24e55a90a71e65d5694714f16199960bf7885724b706a48c ;;
  riscv32-esp-elf) REL_SHA256=b3fce4b04dd15a9f0ed1c209b5a2f389c04eff92ed85e4cc0ebc275b7d95e95a ;;
esac
REL_URL=https://github.com/espressif/crosstool-NG/releases/download/${CT_TAG}/${TARGET}-14.2.0_20260121-x86_64-linux-gnu.tar.xz

JOBS=${JOBS:-4}
OPT=${OPT:--O2}
SRC=${SRC:-/src}
BUILD=${BUILD:-/build}
HOST=/opt/host
# Prefix the wasm tools believe they live in. The manifest's command lines carry -iprefix and
# -isysroot (from the native driver), so the standard dirs resolve into the mounted package.
PREFIX=/opt/${TARGET}
SYSROOT=$PREFIX/$TARGET
NATIVE=/opt/native-${TARGET}
OUT=${OUT:-/out}

HERE=$(cd "$(dirname "$0")" && pwd)

EM_HOST_CFLAGS="$OPT -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
# One module per tool, instantiated per invocation (GCC keeps global state; EXIT_RUNTIME).
EM_HOST_LDFLAGS="$OPT ${EXTRA_LDFLAGS:+$EXTRA_LDFLAGS }-sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sMODULARIZE=1 -sEXPORT_NAME=createTool -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,NODEFS,callMain -sENVIRONMENT=web,worker,node -lnodefs.js"
# Emscripten's libc declares psignal differently from libiberty's fallback; its own works.
export ac_cv_func_psignal=yes
BUILD_TRIPLE=$(/usr/share/misc/config.guess 2>/dev/null || echo aarch64-unknown-linux-gnu)

# get <url> <file> <sha256> <dir>: download, verify, unpack into <dir> (one level stripped).
get() {
  [ -d "$4" ] && return 0
  wget -q "$1" -O "$2"
  echo "$3  $2" | sha256sum -c -
  mkdir "$4" && tar xf "$2" -C "$4" --strip-components=1 && rm "$2"
}

# Chip-independent sources (cached once for all chips).
fetch_common() {
  mkdir -p "$SRC" && cd "$SRC"
  get "https://github.com/espressif/gcc/archive/refs/tags/${GCC_TAG}.tar.gz" gcc.tgz $GCC_SHA256 gcc
  get "https://github.com/espressif/binutils-gdb/archive/refs/tags/${BINUTILS_TAG}.tar.gz" binutils.tgz $BINUTILS_SHA256 binutils
  get "https://github.com/espressif/xtensa-overlays/archive/${OVERLAYS_REV}.tar.gz" overlays.tgz $OVERLAYS_SHA256 overlays
  get https://ftp.gnu.org/gnu/gmp/gmp-${GMP_VERSION}.tar.xz gmp.txz $GMP_SHA256 gmp
  get https://ftp.gnu.org/gnu/mpfr/mpfr-${MPFR_VERSION}.tar.xz mpfr.txz $MPFR_SHA256 mpfr
  get https://ftp.gnu.org/gnu/mpc/mpc-${MPC_VERSION}.tar.gz mpc.tgz $MPC_SHA256 mpc
  for p in "$HERE"/patches/gcc-*.patch; do (cd gcc && patch -p1 --forward < "$p"); done
  for p in "$HERE"/patches/binutils-*.patch; do (cd binutils && patch -p1 --forward < "$p"); done
}

# Per chip: the overlay (chip config compiled in, see above) and the target's headers.
fetch_chip() {
  cd "$SRC"
  if [ -n "$OVERLAY" ]; then
    cp "overlays/${OVERLAY}/gcc/include/xtensa-config.h" gcc/include/xtensa-config.h
    cp "overlays/${OVERLAY}/binutils/include/xtensa-config.h" binutils/include/xtensa-config.h
    cp "overlays/${OVERLAY}/binutils/bfd/xtensa-modules.c" binutils/bfd/xtensa-modules.c
    for f in gcc/include/xtensa-config.h binutils/include/xtensa-config.h; do
      printf '\n/* wasm build: chip compiled in, see patches/*-xtensa-static-dynconfig.patch */\n#define XTENSA_STATIC_DYNCONFIG "%s.so"\n' "$OVERLAY" >> "$f"
    done
  fi
  wget -q "$REL_URL" -O rel.txz
  echo "$REL_SHA256  rel.txz" | sha256sum -c -
  mkdir -p "$SYSROOT"
  tar xJf rel.txz -C "$PREFIX" --strip-components=1 --wildcards "*/${TARGET}/include/*"
  rm rel.txz
  test -f "$SYSROOT/include/stdio.h"
}

hostlibs() {
  mkdir -p "$BUILD/gmp" && cd "$BUILD/gmp"
  emconfigure "$SRC/gmp/configure" --host=none --build="$BUILD_TRIPLE" --disable-assembly \
    --enable-static --disable-shared --prefix=$HOST CFLAGS="$EM_HOST_CFLAGS -std=gnu17" CC_FOR_BUILD=gcc
  emmake make -j"$JOBS" && emmake make install
  mkdir -p "$BUILD/mpfr" && cd "$BUILD/mpfr"
  emconfigure "$SRC/mpfr/configure" --host=none --build="$BUILD_TRIPLE" --enable-static --disable-shared \
    --with-gmp=$HOST --prefix=$HOST CFLAGS="$EM_HOST_CFLAGS"
  emmake make -j"$JOBS" && emmake make install
  mkdir -p "$BUILD/mpc" && cd "$BUILD/mpc"
  emconfigure "$SRC/mpc/configure" --host=none --build="$BUILD_TRIPLE" --enable-static --disable-shared \
    --with-gmp=$HOST --with-mpfr=$HOST --prefix=$HOST CFLAGS="$EM_HOST_CFLAGS"
  emmake make -j"$JOBS" && emmake make install
}

# binutils configure as crosstool-NG does it (scripts/build/binutils/binutils.sh), minus the
# host-only parts (plugins, zstd, gdb/sim are off anyway).
BINUTILS_CONF=(--target=$TARGET --prefix=$PREFIX --with-sysroot=$SYSROOT --disable-werror
  --enable-multilib --disable-nls --disable-sim --disable-gdb --disable-gdbserver --disable-gprof
  --disable-gprofng --disable-readline --disable-libdecnumber --with-pkgversion="$PKGVERSION")

binutils() {
  mkdir -p "$BUILD/binutils" && cd "$BUILD/binutils"
  emconfigure "$SRC/binutils/configure" --build="$BUILD_TRIPLE" --host=i686-pc-linux-gnu \
    "${BINUTILS_CONF[@]}" --disable-shared --disable-plugins --without-zlib --without-zstd \
    CC_FOR_BUILD=gcc CFLAGS="$EM_HOST_CFLAGS" CXXFLAGS="$EM_HOST_CFLAGS" LDFLAGS="$EM_HOST_LDFLAGS"
  emmake make -j"$JOBS" all-gas all-ld
}

# Native (build-machine) as/ld of the same (overlaid) sources. Only GCC's configure runs them: it
# probes the assembler for features (.loc views, SHF_MERGE, COMDAT, …) that decide what cc1
# emits. Without them cc1 silently falls back and the objects are NOT identical.
native_binutils() {
  mkdir -p "$BUILD/binutils-native" && cd "$BUILD/binutils-native"
  "$SRC/binutils/configure" "${BINUTILS_CONF[@]/--prefix=$PREFIX/--prefix=$NATIVE}" --disable-plugins \
    --without-zstd CFLAGS="-O2 -w" CXXFLAGS="-O2 -w"
  make -j"$JOBS" all-gas all-ld all-binutils && make install-gas install-ld install-binutils
}

gcc_() {
  mkdir -p "$BUILD/gcc" && cd "$BUILD/gcc"
  # objdump/readelf/nm of the native target binutils on PATH: some probes also inspect the
  # assembled conftest.o.
  PATH=$NATIVE/bin:$PATH emconfigure "$SRC/gcc/configure" --build="$BUILD_TRIPLE" --host=i686-pc-linux-gnu --target=$TARGET \
    --prefix=$PREFIX --exec_prefix=$PREFIX --with-local-prefix=$SYSROOT --with-sysroot=$SYSROOT \
    --with-native-system-header-dir=/include --with-headers=$SYSROOT/include \
    --with-newlib --enable-threads=no --disable-shared "${EXTRA_GCC_CONF[@]}" \
    --with-pkgversion="$PKGVERSION" --disable-__cxa_atexit --enable-cxx-flags='-ffunction-sections -fdata-sections' \
    --disable-libgomp --disable-libmudflap --disable-libmpx --disable-libssp --disable-libquadmath \
    --disable-libquadmath-support --disable-libstdcxx-verbose \
    --with-gmp=$HOST --with-mpfr=$HOST --with-mpc=$HOST --without-isl --without-zstd \
    --disable-lto --enable-target-optspace --without-long-double-128 --disable-plugin --disable-nls \
    --enable-multiarch --enable-languages=c,c++ --enable-threads=posix --enable-libstdcxx-time=yes \
    --disable-bootstrap --enable-checking=release \
    --with-as=$NATIVE/bin/$TARGET-as --with-ld=$NATIVE/bin/$TARGET-ld \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    OBJDUMP_FOR_TARGET=$NATIVE/bin/$TARGET-objdump READELF_FOR_TARGET=$NATIVE/bin/$TARGET-readelf \
    NM_FOR_TARGET=$NATIVE/bin/$TARGET-nm AS_FOR_TARGET=$NATIVE/bin/$TARGET-as \
    LD_FOR_TARGET=$NATIVE/bin/$TARGET-ld \
    CFLAGS="$EM_HOST_CFLAGS" CXXFLAGS="$EM_HOST_CFLAGS -Wno-register -Wno-c++11-narrowing" \
    LDFLAGS="$EM_HOST_LDFLAGS"
  # all-gcc builds the libraries and generator programs, then fails on programs we do not need
  # (gcov & co.); let it get as far as it gets, then build exactly the two compilers.
  emmake make -k -j"$JOBS" all-gcc || true
  emmake make -C gcc -j"$JOBS" cc1 cc1plus
}

out() {
  mkdir -p "$OUT"
  cp "$BUILD/binutils/gas/as-new" "$OUT/as.js"; cp "$BUILD/binutils/gas/as-new.wasm" "$OUT/as.wasm"
  cp "$BUILD/binutils/ld/ld-new" "$OUT/ld.js";  cp "$BUILD/binutils/ld/ld-new.wasm" "$OUT/ld.wasm"
  cp "$BUILD/gcc/gcc/cc1" "$OUT/cc1.js";        cp "$BUILD/gcc/gcc/cc1.wasm" "$OUT/cc1.wasm"
  cp "$BUILD/gcc/gcc/cc1plus" "$OUT/cc1plus.js"; cp "$BUILD/gcc/gcc/cc1plus.wasm" "$OUT/cc1plus.wasm"
  # The loaders name their .wasm after the build file (as-new.wasm); ship them under the tool name.
  sed -i 's/"as-new\.wasm"/"as.wasm"/' "$OUT/as.js"; sed -i 's/"ld-new\.wasm"/"ld.wasm"/' "$OUT/ld.js"
  ls -la "$OUT"
}

step() { local t0=$SECONDS; "$@"; echo "### step $1 ($CHIP): $((SECONDS - t0)) s"; }

case "${1:-all}" in
  fetch-common) step fetch_common ;;
  fetch-chip) step fetch_chip ;;
  hostlibs) step hostlibs ;;
  binutils) step binutils ;;
  native-binutils) step native_binutils ;;
  gcc) step gcc_ ;;
  out) out ;;
  all) step fetch_common; step hostlibs; step fetch_chip; step binutils; step native_binutils; step gcc_; out ;;
  *) echo "unknown step $1"; exit 2 ;;
esac
