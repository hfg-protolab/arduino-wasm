"""Installs the official bun release binary for this machine, checked against the release's
SHASUMS256.txt. Usage: install-bun.py <version> <dest>"""
import hashlib
import io
import os
import platform
import sys
import urllib.request
import zipfile

version, dest = sys.argv[1], sys.argv[2]
arch = {"x86_64": "x64-baseline", "aarch64": "aarch64", "arm64": "aarch64"}[platform.machine()]
asset = f"bun-linux-{arch}"
base = f"https://github.com/oven-sh/bun/releases/download/bun-v{version}/"
data = urllib.request.urlopen(base + asset + ".zip").read()
sums = urllib.request.urlopen(base + "SHASUMS256.txt").read().decode()
want = next(line.split()[0] for line in sums.splitlines() if line.endswith(f" {asset}.zip"))
if hashlib.sha256(data).hexdigest() != want:
    sys.exit(f"bun {asset}.zip: checksum mismatch")
with zipfile.ZipFile(io.BytesIO(data)) as z, open(dest, "wb") as f:
    f.write(z.read(f"{asset}/bun"))
os.chmod(dest, 0o755)
