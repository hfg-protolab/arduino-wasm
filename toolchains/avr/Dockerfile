# AVR toolchain → WebAssembly (plan: in-browser firmware compiler, phase 0).
#
# Builds only the programs that do work — cc1, cc1plus (GCC 7.3.0), as, ld (binutils
# 2.26.20160125) — for target avr, with Emscripten as the *host* compiler. No gcc driver, no
# collect2, no LTO: the TypeScript driver calls cc1plus → as → ld itself. Target libraries
# (libgcc.a, avr-libc, crt*.o, ldscripts) are platform independent and come from PlatformIO's
# toolchain-atmelavr 1.70300.191015, the toolchain the native build uses today.
#
# Sources = exactly what Arduino builds that toolchain from (github.com/arduino/toolchain-avr,
# tag 7.3.0-atmel3.6.1-arduino7, gcc.build.bash / binutils.build.bash):
#   - GCC 7.3.0 (GNU) + avr-gcc-patches/atmel-patches-gcc.7.3.0-arduino2.patch, --enable-fixed-point
#   - Atmel AVR toolchain 3.6.1 avr-binutils.tar.bz2 + binutils-patches/00-binutils-data_region_length.patch
# Verified: 38/38 objects of an SSD1306 sketch build (core, Wire, SPI, BusIO, GFX, SSD1306,
# sketch) byte-identical to the native toolchain; .hex identical for uno, nano, nano-old.
#
#   docker buildx build --output type=local,dest=<out> toolchains/avr
#
# Host triple i686-pc-linux-gnu: old config.sub does not know emscripten, and i686 has the same
# 32-bit pointers/long as wasm32. CC_FOR_BUILD is the container's native gcc (GCC's gen*
# programs run during the build).
FROM emscripten/emsdk:4.0.10-arm64@sha256:46566098d0e12a11aed071a4aaa20e6a626ab3d011a246846ae2423a21b659d9 AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential flex bison texinfo m4 wget xz-utils bzip2 file patch \
 && rm -rf /var/lib/apt/lists/*

ARG ARDUINO_TAG=7.3.0-atmel3.6.1-arduino7
WORKDIR /src
RUN wget -q https://ftp.gnu.org/gnu/gcc/gcc-7.3.0/gcc-7.3.0.tar.xz \
 && wget -q https://ftp.gnu.org/gnu/gmp/gmp-6.1.2.tar.xz \
 && wget -q https://ftp.gnu.org/gnu/mpfr/mpfr-3.1.6.tar.xz \
 && wget -q https://ftp.gnu.org/gnu/mpc/mpc-1.0.3.tar.gz \
 && wget -q http://downloads.arduino.cc/tools/opensource/Atmel-AVR-GNU-Toolchain/3.6.1/avr-binutils.tar.bz2 \
 && wget -q https://raw.githubusercontent.com/arduino/toolchain-avr/${ARDUINO_TAG}/avr-gcc-patches/atmel-patches-gcc.7.3.0-arduino2.patch \
 && wget -q https://raw.githubusercontent.com/arduino/toolchain-avr/${ARDUINO_TAG}/binutils-patches/00-binutils-data_region_length.patch \
 && printf '%s\n' \
      "832ca6ae04636adbb430e865a1451adf6979ab44ca1c8374f61fba65645ce15c  gcc-7.3.0.tar.xz" \
      "87b565e89a9a684fe4ebeeddb8399dce2599f9c9049854ca8c0dfbdea0e21912  gmp-6.1.2.tar.xz" \
      "7a62ac1a04408614fccdc506e4844b10cf0ad2c2b1677097f8f35d3a1344a950  mpfr-3.1.6.tar.xz" \
      "617decc6ea09889fb08ede330917a00b16809b8db88c29c31bfbb49cbf88ecc3  mpc-1.0.3.tar.gz" \
      "7f2ee50c3867ca13be47aee7925c4c9182b15cb5fe6ace23849ee9005081a340  avr-binutils.tar.bz2" \
      "96782c75dd11e994e1ab9250c41fc5cd81ba65bbcf44383cd9d660d01cc85f97  atmel-patches-gcc.7.3.0-arduino2.patch" \
      "d9e9f183bad9e1cfe27f3569163ccd3c39b1784b12978b47a2206eb31e2547e8  00-binutils-data_region_length.patch" \
    | sha256sum -c - \
 && for f in *.tar.*; do tar xf "$f"; done && rm *.tar.* \
 && (cd gcc-7.3.0 && patch -p1 < ../atmel-patches-gcc.7.3.0-arduino2.patch) \
 && (cd binutils && patch -p1 < ../00-binutils-data_region_length.patch)

# Wasm type-checks indirect calls. gas: three pseudo-op handlers are cast to void(*)(int) →
# small patch. ld/bfd: dozens of such casts (bfd_false & co. in target vectors) → ld is linked
# with -sEMULATE_FUNCTION_POINTER_CASTS (a link-time binaryen pass) instead of patching bfd.
COPY binutils-2.26-wasm-fnptr.patch /src/
RUN cd /src/binutils && patch -p1 < /src/binutils-2.26-wasm-fnptr.patch

# ld: the native avr-gcc links with GCC's LTO plugin, which consumes one section id per input
# (dummy IR bfd); the Mega's .trampolines are ordered by those ids. The wasm ld has no plugin
# support, so it consumes the ids itself (patch header). Only the wasm ld changes: the native
# binutils below are built with plugin support, where the patch is inactive.
COPY binutils-2.26-lto-plugin-ids.patch /src/
RUN cd /src/binutils && patch -p1 < /src/binutils-2.26-lto-plugin-ids.patch

# --- native avr binutils: only so GCC's configure can probe the assembler/linker features.
# Without it GCC assumes an old gas (no COMDAT groups → .gnu.linkonce sections instead of
# .group, other objects than the native toolchain). Not shipped.
RUN mkdir -p /build/native-binutils && cd /build/native-binutils \
 && CC=gcc CXX=g++ CFLAGS="-O2 -w" /src/binutils/configure --target=avr --prefix=/opt/native \
      --disable-nls --disable-werror --disable-gdb --disable-sim --disable-libdecnumber --disable-readline \
 && make -j4 all-gas all-ld && make install-gas install-ld

# Flags for every host (wasm) binary. Configure only compiles/links its tests (cross build),
# so these are harmless there (configure's test link needs INITIAL_MEMORY > STACK_SIZE).
ENV EM_HOST_CFLAGS="-O2 -Wno-error -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types" \
    EM_HOST_LDFLAGS="-O2 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=16MB -sINITIAL_MEMORY=64MB -sMODULARIZE=1 -sEXPORT_NAME=createTool -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8 -sENVIRONMENT=web,worker,node -lnodefs.js"

# libiberty's configure misdetects psignal under Emscripten (then strsignal.c redefines it).
ENV ac_cv_func_psignal=yes

# --- host libraries for GCC (generic C, 32-bit limbs) -------------------------------------
RUN mkdir -p /build/gmp && cd /build/gmp \
 && CC_FOR_BUILD=gcc HOST_CC=gcc emconfigure /src/gmp-6.1.2/configure --host=none --build=$(/src/gmp-6.1.2/config.guess) \
      --disable-assembly --enable-static --disable-shared --prefix=/opt/host CFLAGS="$EM_HOST_CFLAGS" \
 && emmake make -j4 && emmake make install
RUN mkdir -p /build/mpfr && cd /build/mpfr \
 && emconfigure /src/mpfr-3.1.6/configure --host=none --build=$(/src/gmp-6.1.2/config.guess) \
      --enable-static --disable-shared --with-gmp=/opt/host --prefix=/opt/host CFLAGS="$EM_HOST_CFLAGS" \
 && emmake make -j4 && emmake make install
RUN mkdir -p /build/mpc && cd /build/mpc \
 && emconfigure /src/mpc-1.0.3/configure --host=none --build=$(/src/gmp-6.1.2/config.guess) \
      --enable-static --disable-shared --with-gmp=/opt/host --with-mpfr=/opt/host --prefix=/opt/host CFLAGS="$EM_HOST_CFLAGS" \
 && emmake make -j4 && emmake make install

# --- binutils (wasm): as, ld ---------------------------------------------------------------
RUN mkdir -p /build/binutils && cd /build/binutils \
 && emconfigure /src/binutils/configure \
      --build=$(/src/binutils/config.guess) --host=i686-pc-linux-gnu --target=avr \
      --disable-nls --disable-werror --disable-shared --disable-plugins --disable-gdb --disable-sim \
      --disable-readline --disable-libdecnumber --without-zlib \
      CC_FOR_BUILD=gcc CFLAGS="$EM_HOST_CFLAGS" LDFLAGS="$EM_HOST_LDFLAGS" \
 && emmake make -j4 all-gas all-ld \
 && rm ld/ld-new ld/ld-new.wasm && emmake make -C ld ld-new LDFLAGS="$EM_HOST_LDFLAGS -sEMULATE_FUNCTION_POINTER_CASTS=1"

# --- gcc (wasm): cc1, cc1plus --------------------------------------------------------------
# `all-gcc` fails late (gcov-tool needs ftw; selftest/specs would run the wasm xgcc) — the
# libraries it needs are built by then; cc1/cc1plus are built as explicit targets afterwards.
RUN mkdir -p /build/gcc && cd /build/gcc \
 && emconfigure /src/gcc-7.3.0/configure \
      --build=$(/src/gcc-7.3.0/config.guess) --host=i686-pc-linux-gnu --target=avr \
      --enable-fixed-point --enable-languages=c,c++ --disable-nls --disable-shared --disable-plugin --disable-lto \
      --disable-libssp --disable-libada --disable-libcc1 --without-isl --with-avrlibc=yes --with-dwarf2 \
      --disable-bootstrap --enable-checking=release \
      --with-gnu-as --with-gnu-ld --with-as=/opt/native/bin/avr-as --with-ld=/opt/native/bin/avr-ld \
      --with-gmp=/opt/host --with-mpfr=/opt/host --with-mpc=/opt/host \
      CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ CXXFLAGS_FOR_BUILD="-O2 -std=gnu++98" \
      CFLAGS="$EM_HOST_CFLAGS" CXXFLAGS="$EM_HOST_CFLAGS -std=gnu++98 -Wno-register -Wno-c++11-narrowing" \
      LDFLAGS="$EM_HOST_LDFLAGS" \
 && (emmake make -j4 all-gcc || true) \
 && emmake make -C gcc -j4 cc1 cc1plus

RUN mkdir -p /out \
 && cp /build/binutils/gas/as-new /out/as.js && cp /build/binutils/gas/as-new.wasm /out/as.wasm \
 && cp /build/binutils/ld/ld-new /out/ld.js && cp /build/binutils/ld/ld-new.wasm /out/ld.wasm \
 && cp /build/gcc/gcc/cc1 /out/cc1.js && cp /build/gcc/gcc/cc1.wasm /out/cc1.wasm \
 && cp /build/gcc/gcc/cc1plus /out/cc1plus.js && cp /build/gcc/gcc/cc1plus.wasm /out/cc1plus.wasm \
 && sed -i 's/"as-new.wasm"/"as.wasm"/' /out/as.js && sed -i 's/"ld-new.wasm"/"ld.wasm"/' /out/ld.js \
 && ls -la /out

FROM scratch
COPY --from=build /out /
