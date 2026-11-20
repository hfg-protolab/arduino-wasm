# ESP8266 toolchain → WebAssembly (in-browser firmware compiler).
#
# cc1, cc1plus (GCC 10.3.0 + esp-quick-toolchain patches) and as, ld (binutils 2.32), target
# xtensa-lx106-elf, built with Emscripten as the host compiler — the exact sources of PlatformIO's
# toolchain-xtensa@2.100300.220621 (espressif8266@4.2.1, Arduino ESP8266 3.1.2):
#
#   docker buildx build --output type=local,dest=.build/toolchains/esp8266 toolchains/esp8266
#
# Everything is fetched by build.sh from pinned URLs with SHA-256 checks (../sources.json).
# The lx106 configuration is compiled in (as in the native toolchain; no dynconfig).
ARG EMSDK_IMAGE=emscripten/emsdk:4.0.10-arm64@sha256:46566098d0e12a11aed071a4aaa20e6a626ab3d011a246846ae2423a21b659d9
FROM ${EMSDK_IMAGE} AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential flex bison texinfo m4 wget xz-utils bzip2 file patch \
 && rm -rf /var/lib/apt/lists/*

ARG JOBS=4
ENV JOBS=${JOBS}
ARG OPT=-O2
ENV OPT=${OPT}

COPY patches /tc/patches
COPY build.sh /tc/build.sh
RUN bash /tc/build.sh fetch
RUN bash /tc/build.sh hostlibs
RUN bash /tc/build.sh binutils
RUN bash /tc/build.sh native-binutils
RUN bash /tc/build.sh gcc
RUN bash /tc/build.sh out

FROM scratch
COPY --from=build /out /
