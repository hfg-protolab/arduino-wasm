# Espressif toolchains for Arduino-ESP32 3.x → WebAssembly (in-browser firmware compiler).
#
# cc1, cc1plus (GCC 14.2.0, Espressif fork) and as, ld (binutils 2.43.1, Espressif fork), built
# with Emscripten as the host compiler — the exact sources of pioarduino's toolchain packages
# 14.2.0+20260121 (platform-espressif32 55.03.39, Arduino-ESP32 3.3.9):
#
#   docker buildx build --output type=local,dest=.build/toolchains/esp32-v3   toolchains/esp14
#   docker buildx build --output type=local,dest=.build/toolchains/esp32s3-v3 --build-arg CHIP=esp32s3 toolchains/esp14
#   docker buildx build --output type=local,dest=.build/toolchains/riscv32-v3 --build-arg CHIP=riscv32 toolchains/esp14
#
# xtensa-esp-elf loads its chip configuration at run time (dynconfig, dlopen). wasm cannot, so
# there is one Xtensa build per chip with the configuration compiled in (see build.sh and
# patches/). riscv32 is one build for esp32c3 and esp32c6 (-march/-mabi come per board).
#
# Everything is fetched by build.sh from pinned URLs with SHA-256 checks (../sources.json).
# Target libraries and headers come from the PlatformIO package at run time, not from this image.
# The chip-independent steps (sources, GMP/MPFR/MPC) come before ARG CHIP and are cached once.
# The emsdk image is single-arch per tag; on x86_64 use EMSDK_IMAGE=emscripten/emsdk:4.0.10.
ARG EMSDK_IMAGE=emscripten/emsdk:4.0.10-arm64@sha256:46566098d0e12a11aed071a4aaa20e6a626ab3d011a246846ae2423a21b659d9
FROM ${EMSDK_IMAGE} AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential flex bison texinfo m4 wget xz-utils bzip2 file patch \
 && rm -rf /var/lib/apt/lists/*

ARG JOBS=4
ENV JOBS=${JOBS}

COPY patches /tc/patches
COPY build.sh /tc/build.sh
RUN bash /tc/build.sh fetch-common
RUN bash /tc/build.sh hostlibs

ARG CHIP=esp32
# Optimisation level of the wasm tools (GMP/MPFR/MPC above stay at -O2).
ARG OPT=-O2
ENV CHIP=${CHIP} OPT=${OPT}
RUN bash /tc/build.sh fetch-chip
RUN bash /tc/build.sh binutils
RUN bash /tc/build.sh native-binutils
RUN bash /tc/build.sh gcc
RUN bash /tc/build.sh out

FROM scratch
COPY --from=build /out /
