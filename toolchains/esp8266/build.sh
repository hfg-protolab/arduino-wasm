#!/usr/bin/env bash
# ESP8266 toolchain → WebAssembly: xtensa-lx106-elf GCC 10.3.0 + binutils 2.32, the sources of
# PlatformIO's toolchain-xtensa@2.100300.220621 (espressif8266@4.2.1, Arduino ESP8266 3.1.2).
# Builds only cc1, cc1plus, as and ld; no driver, no collect2, no LTO.
#
#   build.sh fetch | hostlibs | binutils | native-binutils | gcc | out   (or: all)
#
# PlatformIO's package is byte-identical to earlephilhower/esp-quick-toolchain's release
# 3.1.0-gcc10.3 (x86_64-linux-gnu.xtensa-lx106-elf-e5f9fec.220621), built by its Makefile at
# commit e5f9fec6c7fa8399c52015eea27f0836f8cccfe9 (the GitHub tag 3.1.0-gcc10.3 is its parent;
# the release tarball names e5f9fec). That Makefile:
#   - gcc: git tag releases/gcc-10.3.0, patches/gcc-*.patch then patches/gcc10.3/gcc-*.patch
#   - binutils: binutils-gdb tag binutils-2_32, patches/bin-*.patch (only gdb/, inert here)
#   - lx106 configuration: include/xtensa-config.h of gcc and binutils overwritten with
#     lx106-hal's core-isa.h + system.h + four XCHAL_HAVE_FP_* 0 lines (bfd/xtensa-modules.c stays
#     upstream's)
#   - configure (binutils and gcc): the list in CONF below, no --with-pkgversion ("(GCC)")
# gcc is taken from the release tarball (same tree as the tag plus generated files).
set -euo pipefail

TARGET=xtensa-lx106-elf
EQT_REV=e5f9fec6c7fa8399c52015eea27f0836f8cccfe9
EQT_SHA256=25cbf94ace3144bf073760b21b16208ba56dccd593ce38cda442133687589f67
HAL_REV=e4bcc63c9c016e4f8848e7e8f512438ca857531d
HAL_SHA256=f61acf7dd0e32c5cab6ce38d3cab10f5fe366454288b74b4ee16182f45b6bc24
GCC_SHA256=64f404c1a650f27fc33da242e1f2df54952e3963a49e06e73f6940f3223ac344          # gcc-10.3.0.tar.xz
BINUTILS_REV=a9d9a104dde6a749f40ce5c4576a0042a7d52d1f                                 # tag binutils-2_32
BINUTILS_SHA256=2c8f4f05070eb3799193203cc7ef491117dfa8b681a695481954b38feabdd934
# The versions esp-quick-toolchain unpacks into the gcc tree (gcc.gnu.org/pub/gcc/infrastructure).
GMP_SHA256=498449a994efeba527885c10405993427995d3f86b8768d8cdf8d9dd7c6b73e8          # gmp-6.1.0.tar.bz2
MPFR_SHA256=d3103a80cdad2407ed581f3618c4bed04e0c92d1cf771a65ead662cc397f7775         # mpfr-3.1.4.tar.bz2
MPC_SHA256=617decc6ea09889fb08ede330917a00b16809b8db88c29c31bfbb49cbf88ecc3          # mpc-1.0.3.tar.gz

JOBS=${JOBS:-4}
OPT=${OPT:--O2}
SRC=${SRC:-/src}
BUILD=${BUILD:-/build}
HOST=/opt/host
PREFIX=/opt/${TARGET}
NATIVE=/opt/native-${TARGET}
OUT=${OUT:-/out}
HERE=$(cd "$(dirname "$0")" && pwd)

# esp-quick-toolchain's configure list (Makefile, `configure +=`), --enable-lto aside.
CONF=(--target=$TARGET --disable-shared --with-newlib --enable-threads=no --disable-__cxa_atexit
  --disable-libgomp --disable-libmudflap --disable-nls --disable-multilib --disable-bootstrap
  --enable-languages=c,c++ --enable-static=yes --disable-libstdcxx-verbose)

EM_HOST_CFLAGS="$OPT -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
EM_HOST_LDFLAGS="$OPT -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sMODULARIZE=1 -sEXPORT_NAME=createTool -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,NODEFS,callMain -sENVIRONMENT=web,worker,node -lnodefs.js"
export ac_cv_func_psignal=yes
BUILD_TRIPLE=$(/usr/share/misc/config.guess 2>/dev/null || echo aarch64-unknown-linux-gnu)

get() {
  [ -d "$4" ] && return 0
  wget -q "$1" -O "$2"
  echo "$3  $2" | sha256sum -c -
  mkdir "$4" && tar xf "$2" -C "$4" --strip-components=1 && rm "$2"
}

fetch() {
  mkdir -p "$SRC" && cd "$SRC"
  get https://ftp.gnu.org/gnu/gcc/gcc-10.3.0/gcc-10.3.0.tar.xz gcc.txz $GCC_SHA256 gcc
  get https://github.com/gnutools/binutils-gdb/archive/${BINUTILS_REV}.tar.gz binutils.tgz $BINUTILS_SHA256 binutils
  get https://github.com/earlephilhower/esp-quick-toolchain/archive/${EQT_REV}.tar.gz eqt.tgz $EQT_SHA256 eqt
  get https://github.com/earlephilhower/lx106-hal/archive/${HAL_REV}.tar.gz hal.tgz $HAL_SHA256 lx106-hal
  get https://gcc.gnu.org/pub/gcc/infrastructure/gmp-6.1.0.tar.bz2 gmp.tbz $GMP_SHA256 gmp
  get https://gcc.gnu.org/pub/gcc/infrastructure/mpfr-3.1.4.tar.bz2 mpfr.tbz $MPFR_SHA256 mpfr
  get https://gcc.gnu.org/pub/gcc/infrastructure/mpc-1.0.3.tar.gz mpc.tgz $MPC_SHA256 mpc
  # .stage.patch of esp-quick-toolchain's Makefile, in its glob order.
  [ -f gcc/.patched ] || {
    for p in eqt/patches/gcc-*.patch eqt/patches/gcc10.3/gcc-*.patch; do (cd gcc && patch -s -p1 < "../$p"); done
    for p in eqt/patches/bin-*.patch; do (cd binutils && patch -s -p1 < "../$p"); done
    for ow in gcc/include/xtensa-config.h binutils/include/xtensa-config.h; do
      ( cat lx106-hal/include/xtensa/config/core-isa.h; cat lx106-hal/include/xtensa/config/system.h
        echo '#define XCHAL_HAVE_FP_DIV   0'; echo '#define XCHAL_HAVE_FP_RECIP 0'
        echo '#define XCHAL_HAVE_FP_SQRT  0'; echo '#define XCHAL_HAVE_FP_RSQRT 0' ) > "$ow"
    done
    # ours: PCH on wasm32 (GCC 10 cannot relocate a PCH)
    (cd gcc && patch -p1 < "$HERE/patches/gcc-10-pch-emscripten.patch")
    touch gcc/.patched
  }
}

hostlibs() {
  mkdir -p "$BUILD/gmp" && cd "$BUILD/gmp"
  emconfigure "$SRC/gmp/configure" --host=none --build="$BUILD_TRIPLE" --disable-assembly \
    --enable-static --disable-shared --prefix=$HOST CFLAGS="$EM_HOST_CFLAGS" CC_FOR_BUILD=gcc HOST_CC=gcc
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

# binutils-gdb git tree: no prebuilt docs; MAKEINFO=true skips them.
binutils() {
  mkdir -p "$BUILD/binutils" && cd "$BUILD/binutils"
  emconfigure "$SRC/binutils/configure" --build="$BUILD_TRIPLE" --host=i686-pc-linux-gnu --prefix=$PREFIX \
    "${CONF[@]}" --disable-werror --disable-plugins --disable-gdb --disable-sim --disable-readline \
    --disable-libdecnumber --disable-gprof --without-zlib \
    CC_FOR_BUILD=gcc CFLAGS="$EM_HOST_CFLAGS" LDFLAGS="$EM_HOST_LDFLAGS" MAKEINFO=true
  emmake make -j"$JOBS" MAKEINFO=true all-gas all-ld
}

# Native as/ld of the same sources, only for GCC's configure (assembler feature probes).
native_binutils() {
  mkdir -p "$BUILD/binutils-native" && cd "$BUILD/binutils-native"
  "$SRC/binutils/configure" --prefix=$NATIVE "${CONF[@]}" --disable-werror --disable-gdb --disable-sim \
    --disable-gprof CFLAGS="-O2 -w" MAKEINFO=true
  make -j"$JOBS" MAKEINFO=true all-gas all-ld all-binutils && make MAKEINFO=true install-gas install-ld install-binutils
}

gcc_() {
  mkdir -p "$BUILD/gcc" && cd "$BUILD/gcc"
  PATH=$NATIVE/bin:$PATH emconfigure "$SRC/gcc/configure" --build="$BUILD_TRIPLE" --host=i686-pc-linux-gnu \
    --prefix=$PREFIX "${CONF[@]}" \
    --with-gmp=$HOST --with-mpfr=$HOST --with-mpc=$HOST --without-isl --disable-lto --disable-plugin \
    --enable-checking=release \
    --with-as=$NATIVE/bin/$TARGET-as --with-ld=$NATIVE/bin/$TARGET-ld \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    OBJDUMP_FOR_TARGET=$NATIVE/bin/$TARGET-objdump READELF_FOR_TARGET=$NATIVE/bin/$TARGET-readelf \
    NM_FOR_TARGET=$NATIVE/bin/$TARGET-nm AS_FOR_TARGET=$NATIVE/bin/$TARGET-as LD_FOR_TARGET=$NATIVE/bin/$TARGET-ld \
    CFLAGS="$EM_HOST_CFLAGS" CXXFLAGS="$EM_HOST_CFLAGS -std=gnu++11 -Wno-register -Wno-c++11-narrowing" \
    LDFLAGS="$EM_HOST_LDFLAGS"
  emmake make -k -j"$JOBS" all-gcc || true
  emmake make -C gcc -j"$JOBS" cc1 cc1plus
}

out() {
  mkdir -p "$OUT"
  cp "$BUILD/binutils/gas/as-new" "$OUT/as.js"; cp "$BUILD/binutils/gas/as-new.wasm" "$OUT/as.wasm"
  cp "$BUILD/binutils/ld/ld-new" "$OUT/ld.js";  cp "$BUILD/binutils/ld/ld-new.wasm" "$OUT/ld.wasm"
  cp "$BUILD/gcc/gcc/cc1" "$OUT/cc1.js";        cp "$BUILD/gcc/gcc/cc1.wasm" "$OUT/cc1.wasm"
  cp "$BUILD/gcc/gcc/cc1plus" "$OUT/cc1plus.js"; cp "$BUILD/gcc/gcc/cc1plus.wasm" "$OUT/cc1plus.wasm"
  sed -i 's/"as-new\.wasm"/"as.wasm"/' "$OUT/as.js"; sed -i 's/"ld-new\.wasm"/"ld.wasm"/' "$OUT/ld.js"
  ls -la "$OUT"
}

step() { local t0=$SECONDS; "$@"; echo "### step $1: $((SECONDS - t0)) s"; }

case "${1:-all}" in
  fetch) step fetch ;;
  hostlibs) step hostlibs ;;
  binutils) step binutils ;;
  native-binutils) step native_binutils ;;
  gcc) step gcc_ ;;
  out) out ;;
  all) step fetch; step hostlibs; step binutils; step native_binutils; step gcc_; out ;;
  *) echo "unknown step $1"; exit 2 ;;
esac
