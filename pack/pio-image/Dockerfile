# pio-image: the environment production packs are built in (README "Building a pack").
# PlatformIO Core, pinned, with the platforms, toolchains, Arduino cores and the allowed
# libraries of the boards already installed at the paths the packs carry (/opt/pio,
# /opt/pio-libs/<dir>), so `__FILE__` strings and debug paths never name a developer's home.
# Formerly the AI Hub's `aihub-pio` image of its server-side firmware jobs (app-runner).
#
#   docker build -t arduino-wasm-pio pack/pio-image
#
# Build a pack / the test fixtures in it, with the checkout mounted (the work dir on a volume:
# faster than the bind mount, and pio writes into /opt/pio, so run as root):
#
#   docker run --rm -u 0 -v "$PWD:/src" -v arduino-wasm-work:/src/.build/pack-work -w /src \
#       arduino-wasm-pio bun pack/build.ts
#   docker run --rm -u 0 -v "$PWD:/src" -w /src arduino-wasm-pio scripts/generate-fixtures.sh /work
#
# Pre-fetch by BUILDING a template project per board (prefetch/), not with
# `pio pkg install -p espressif32` (that pulls every chip's toolchain).
FROM python:3.12-slim

ARG PLATFORMIO_VERSION=6.2.0

# Image-build values. A run may point CORE/CACHE at a tmpfs and read platforms, packages and
# libraries from here, read-only.
ENV PLATFORMIO_CORE_DIR=/opt/pio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=No \
    PLATFORMIO_SETTING_CHECK_PLATFORMIO_INTERVAL=3650 \
    PLATFORMIO_SETTING_CHECK_PRUNE_SYSTEM_THRESHOLD=0 \
    PLATFORMIO_DISABLE_PROGRESSBAR=true \
    PLATFORMIO_NO_ANSI=true \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# git: pioarduino (platform-espressif32 55.x) refuses to run without it.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

RUN pip install "platformio==${PLATFORMIO_VERSION}" \
 && pio --version \
 && pio settings set enable_telemetry No

COPY prefetch /opt/pio-template
RUN pio run -d /opt/pio-template \
 && rm -rf /opt/pio-template/.pio

COPY libraries.txt /opt/pio-libs.txt
RUN set -eu; \
    mkdir -p /opt/pio-libs/all /opt/pio-libs/avr /opt/pio-libs/esp32 /opt/pio-libs/esp8266; \
    grep -v '^#' /opt/pio-libs.txt | grep -v '^$' | while read -r dir spec; do \
        pio pkg install --global --storage-dir "/opt/pio-libs/${dir}" --library "${spec}"; \
    done; \
    ls /opt/pio-libs/*

# bun runs the pack builder (pack/build.ts), the fixture script and the tests inside this image.
# The official release binary, pinned and checked against the release's SHASUMS256.txt.
ARG BUN_VERSION=1.4.4
COPY install-bun.py /tmp/install-bun.py
RUN python /tmp/install-bun.py "$BUN_VERSION" /usr/local/bin/bun \
 && rm /tmp/install-bun.py \
 && bun --version

# Where pack/common.ts finds PlatformIO and the allowed libraries in this image (pio itself is
# on PATH, the packages under PLATFORMIO_CORE_DIR=/opt/pio).
ENV PACK_LIBS=/opt/pio-libs

# The downloads cache is not needed at run time. PlatformIO takes `<dir>.lock` next to the
# platforms and packages dirs before it even checks that a package is installed; with a
# read-only root the locks live on a tmpfs (create /tmp/pio-locks before running pio).
RUN rm -rf /opt/pio/.cache /root/.cache /opt/pio/platforms.lock /opt/pio/packages.lock \
 && ln -s /tmp/pio-locks/platforms.lock /opt/pio/platforms.lock \
 && ln -s /tmp/pio-locks/packages.lock /opt/pio/packages.lock \
 && find /opt/pio /opt/pio-libs ! -perm -o+r -exec chmod o+rX {} + \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin pio

USER 1000:1000
WORKDIR /work
# the lock dir the symlinks above point at
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p /tmp/pio-locks && exec \"$@\"", "--"]
CMD ["pio", "--version"]
