#!/usr/bin/env bash
# Espressif GCC 8.4.0 + binutils 2.35.1 → WebAssembly, one toolchain per chip:
#   CHIP=esp32    xtensa-esp32-elf    (overlay xtensa_esp32)
#   CHIP=esp32s3  xtensa-esp32s3-elf  (overlay xtensa_esp32s3)
#   CHIP=esp32c3  riscv32-esp-elf     (no overlay; --with-arch=rv32gc --with-abi=ilp32)
# Runs inside emscripten/emsdk (see Dockerfile). Builds only cc1, cc1plus, as and ld; no driver,
# no collect2, no LTO.
#
#   build.sh fetch-common | hostlibs | fetch-chip | binutils | native-binutils | gcc | out
#   (or: build.sh all)
#
# Sources = exactly what PlatformIO's toolchain-{xtensa-esp32,xtensa-esp32s3,riscv32-esp}
# 8.4.0+2021r2-patch5 were built from (crosstool-NG tag esp-2021r2-patch5,
# samples/<target>/crosstool.config): see ../sources.json. crosstool-NG applies no patches to git
# sources, so the only patch is ours (PCH on wasm).
#
# Configure flags mirror `<target>-gcc -v` of the native package (prefix aside): the ones that
# change generated code (--disable-__cxa_atexit, --enable-threads=posix, newlib, multilib,
# --with-arch/--with-abi, pkgversion in .comment) must match for byte-identical objects.
set -euo pipefail

CHIP=${CHIP:-esp32}
case "$CHIP" in
  esp32)   TARGET=xtensa-esp32-elf;   OVERLAY=xtensa_esp32;   EXTRA_GCC_CONF=()
           REL_SHA256=8ef14e0409c2011b41e504a30f70d3e35287313a795d1f2462ad2cd0e2052d37 ;;
  esp32s3) TARGET=xtensa-esp32s3-elf; OVERLAY=xtensa_esp32s3; EXTRA_GCC_CONF=()
           REL_SHA256=8aa17a6adf01efa5b1628c8ac578063a44d26ae9581d39486b92223a41ef262f ;;
  esp32c3) TARGET=riscv32-esp-elf;    OVERLAY=;               EXTRA_GCC_CONF=(--with-arch=rv32gc --with-abi=ilp32)
           REL_SHA256=f7d73e5f9e2df3ea6ca8e2c95d6ca6d23d6b38fd101ea5d3012f3cb3cd59f39f ;;
  *) echo "unknown CHIP $CHIP (esp32 | esp32s3 | esp32c3)"; exit 2 ;;
esac

CT_TAG=esp-2021r2-patch5
GCC_TAG=esp-2021r2-patch4                    # commit 3b3d328ad0dfd53636d2d54e98b77bfcdacefac4
GCC_SHA256=6baba8db4731a91d825e9b1f44f2a9128c6dae51074ef7b9d5318174c27fec1f
BINUTILS_TAG=esp-2021r2-patch4-binutils      # commit df444b49d425e05f538d7875f8e2162771c74a51
BINUTILS_SHA256=542a3c96f3f2dc692815ba47b60f02dc55544e69f94267112f9ded53c94242be
OVERLAYS_REV=dd1cf19f6eb327a9db51043439974a6de13f5c7f
OVERLAYS_SHA256=2ff44e3932c4209d4be2ea8f4863c4c19d96636fd308ea7c557206be86f92c56
PKGVERSION="crosstool-NG ${CT_TAG}"
GMP_VERSION=6.2.1;  GMP_SHA256=fd4829912cddd12f84181c3451cc752be224643e87fac497b69edddadc49b4f2
MPFR_VERSION=4.1.0; MPFR_SHA256=0c98a3f1732ff6ca4ea690552079da9c597872d30e96ec28414ee23c95558a7f
MPC_VERSION=1.2.1;  MPC_SHA256=17503d2c395dfcf106b622dc142683c1199431d095367c6aacba6eec30340459
# Espressif's binary release of the same toolchain. Only its newlib headers are used (GCC's
# configure inspects them via --with-headers, as in crosstool-NG); the linux-amd64 archive is
# taken on every build host because headers are host independent. Checksum from the release's
# crosstool-NG-esp-2021r2-patch5-checksum.sha256.
REL_URL=https://github.com/espressif/crosstool-NG/releases/download/${CT_TAG}/${TARGET}-gcc8_4_0-${CT_TAG}-linux-amd64.tar.gz

JOBS=${JOBS:-4}
OPT=${OPT:--O2}
SRC=${SRC:-/src}
BUILD=${BUILD:-/build}
HOST=/opt/host
# Prefix the wasm cc1plus believes it lives in. The driver replacement passes -iprefix (as the
# native driver does) so the standard include dirs resolve into the mounted native package.
PREFIX=/opt/${TARGET}
NATIVE=/opt/native-${TARGET}
OUT=${OUT:-/out}

HERE=$(cd "$(dirname "$0")" && pwd)

EM_HOST_CFLAGS="$OPT -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
# One module per tool, instantiated per invocation (GCC keeps global state; EXIT_RUNTIME).
EM_HOST_LDFLAGS="$OPT -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sMODULARIZE=1 -sEXPORT_NAME=createTool -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,NODEFS,callMain -sENVIRONMENT=web,worker,node -lnodefs.js"
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

# Chip-independent sources (cached once for all three chips).
fetch_common() {
  mkdir -p "$SRC" && cd "$SRC"
  get "https://github.com/espressif/gcc/archive/refs/tags/${GCC_TAG}.tar.gz" gcc.tgz $GCC_SHA256 gcc
  get "https://github.com/espressif/binutils-gdb/archive/refs/tags/${BINUTILS_TAG}.tar.gz" binutils.tgz $BINUTILS_SHA256 binutils
  get "https://github.com/espressif/xtensa-overlays/archive/${OVERLAYS_REV}.tar.gz" overlays.tgz $OVERLAYS_SHA256 overlays
  get https://ftp.gnu.org/gnu/gmp/gmp-${GMP_VERSION}.tar.xz gmp.txz $GMP_SHA256 gmp
  get https://ftp.gnu.org/gnu/mpfr/mpfr-${MPFR_VERSION}.tar.xz mpfr.txz $MPFR_SHA256 mpfr
  get https://ftp.gnu.org/gnu/mpc/mpc-${MPC_VERSION}.tar.gz mpc.tgz $MPC_SHA256 mpc
  (cd gcc && patch -p1 --forward < "$HERE/patches/gcc-8-pch-emscripten.patch")
}

# Per chip: the overlay (chip config compiled in: xtensa-config.h, xtensa-modules.c — this
# toolchain generation has no dynconfig) and the target's newlib headers.
fetch_chip() {
  cd "$SRC"
  if [ -n "$OVERLAY" ]; then
    cp -r "overlays/${OVERLAY}/gcc/." gcc/
    cp -r "overlays/${OVERLAY}/binutils/." binutils/
  fi
  wget -q "$REL_URL" -O rel.tgz
  echo "$REL_SHA256  rel.tgz" | sha256sum -c -
  mkdir -p "$PREFIX/$TARGET"
  tar xzf rel.tgz -C "$PREFIX" --strip-components=1 --wildcards "*/${TARGET}/include/*"
  rm rel.tgz
  test -f "$PREFIX/$TARGET/include/stdio.h"
}

hostlibs() {
  mkdir -p "$BUILD/gmp" && cd "$BUILD/gmp"
  emconfigure "$SRC/gmp/configure" --host=none --build="$BUILD_TRIPLE" --disable-assembly \
    --enable-static --disable-shared --prefix=$HOST CFLAGS="$EM_HOST_CFLAGS" CC_FOR_BUILD=gcc
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

binutils() {
  mkdir -p "$BUILD/binutils" && cd "$BUILD/binutils"
  emconfigure "$SRC/binutils/configure" --build="$BUILD_TRIPLE" --host=i686-pc-linux-gnu --target=$TARGET \
    --prefix=$PREFIX --disable-nls --disable-werror --disable-shared --disable-plugins --disable-gdb \
    --disable-sim --disable-gprof --disable-readline --disable-libdecnumber --without-zlib \
    --with-pkgversion="$PKGVERSION" \
    CC_FOR_BUILD=gcc CFLAGS="$EM_HOST_CFLAGS" LDFLAGS="$EM_HOST_LDFLAGS"
  emmake make -j"$JOBS" all-gas all-ld
}

# Native (build-machine) as/ld of the same sources. Only GCC's configure runs them: it probes the
# assembler for features (.loc views, SHF_MERGE string sections, COMDAT groups, …) that decide
# what cc1 emits. Without them cc1 silently falls back (no .rodata.str1.1 merging, different
# .gcc_except_table/debug info) and the firmware is NOT identical. crosstool-NG has the target
# as/ld installed at that point for the same reason.
native_binutils() {
  mkdir -p "$BUILD/binutils-native" && cd "$BUILD/binutils-native"
  "$SRC/binutils/configure" --target=$TARGET --prefix=$NATIVE --disable-nls --disable-werror \
    --disable-gdb --disable-sim --disable-gprof --disable-plugins
  make -j"$JOBS" all-gas all-ld all-binutils && make install-gas install-ld install-binutils
}

gcc_() {
  mkdir -p "$BUILD/gcc" && cd "$BUILD/gcc"
  # objdump/readelf/nm of the native target binutils on PATH: some probes (e.g. dwarf2
  # debug_line → `.loc` directives) also inspect the assembled conftest.o.
  PATH=$NATIVE/bin:$PATH emconfigure "$SRC/gcc/configure" --build="$BUILD_TRIPLE" --host=i686-pc-linux-gnu --target=$TARGET \
    --prefix=$PREFIX --exec_prefix=$PREFIX --with-local-prefix=$PREFIX/$TARGET \
    --with-headers=$PREFIX/$TARGET/include --with-newlib --enable-threads=no --disable-shared \
    "${EXTRA_GCC_CONF[@]}" \
    --with-pkgversion="$PKGVERSION" --disable-__cxa_atexit --enable-cxx-flags=-ffunction-sections \
    --disable-libgomp --disable-libmudflap --disable-libmpx --disable-libssp --disable-libquadmath \
    --disable-libquadmath-support --disable-libstdcxx-verbose \
    --with-gmp=$HOST --with-mpfr=$HOST --with-mpc=$HOST --without-isl \
    --disable-lto --disable-plugin --enable-target-optspace --without-long-double-128 --disable-nls \
    --enable-multiarch --enable-languages=c,c++ --enable-threads=posix --enable-gcov-custom-rtio \
    --enable-libstdcxx-time=yes --disable-bootstrap --enable-checking=release \
    --with-as=$NATIVE/bin/$TARGET-as --with-ld=$NATIVE/bin/$TARGET-ld \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    OBJDUMP_FOR_TARGET=$NATIVE/bin/$TARGET-objdump READELF_FOR_TARGET=$NATIVE/bin/$TARGET-readelf \
    NM_FOR_TARGET=$NATIVE/bin/$TARGET-nm AS_FOR_TARGET=$NATIVE/bin/$TARGET-as \
    LD_FOR_TARGET=$NATIVE/bin/$TARGET-ld \
    CFLAGS="$EM_HOST_CFLAGS" CXXFLAGS="$EM_HOST_CFLAGS -std=gnu++11 -Wno-register -Wno-c++11-narrowing" \
    LDFLAGS="$EM_HOST_LDFLAGS"
  # all-gcc builds the libraries and the generator programs (with CC_FOR_BUILD, which the top
  # level passes down) but then fails on gcov/gcov-tool: they do not compile against
  # Emscripten's libc++ (<locale> vs GCC's poisoned identifiers) and are not needed. So: let it
  # get as far as it gets, then build exactly the two programs.
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
