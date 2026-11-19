"""Run PlatformIO's own InoToCPPConverter on a directory of .ino/.pde files.

Usage: pio-ino.py <CXX> <src_dir> [virtual_src_dir]

Prints the generated .ino.cpp to stdout (exact bytes). The sketch paths inside the output are
`<virtual_src_dir>/<name>` (default /work/project/src, the project path of the reference builds) and
the temporary file gcc preprocesses is called `tmpfixture` (PlatformIO uses a random mkstemp()
name there, which appears in line 1 of its output), so the output is reproducible.
"""
import glob
import io
import os
import shutil
import subprocess
import sys
import tempfile

# a developer's ~/.platformio penv; in the pio-image PlatformIO is in the system python
sys.path.insert(0, os.path.expanduser("~/.platformio/penv/lib/python3.11/site-packages"))
from platformio.builder.tools import pioino  # noqa: E402

cxx, src = sys.argv[1], os.path.abspath(sys.argv[2])
virtual = sys.argv[3] if len(sys.argv) > 3 else "/work/project/src"
root = tempfile.mkdtemp()
os.chdir(root)


def real(path):
    return root + path if path.startswith("/") else path


class Node:
    def __init__(self, path):
        self.path = path

    def get_path(self):
        return self.path


class Env:
    def VerboseAction(self, cmd, _msg):
        return cmd.replace("$CXX", cxx)

    def Execute(self, cmd):
        subprocess.run(cmd, shell=True, check=True)


class Converter(pioino.InoToCPPConverter):
    def read_safe_contents(self, path):
        return super().read_safe_contents(real(path))

    def write_safe_contents(self, path, contents):
        return super().write_safe_contents(real(path), contents)

    def _gcc_preprocess(self, contents, out_file):
        return super()._gcc_preprocess(contents, real(out_file))


pioino.tempfile.mkstemp = lambda: (None, "tmpfixture")
os.makedirs(real(virtual), exist_ok=True)
names = []
for pattern in ("*.ino", "*.pde"):
    # SCons' Glob returns the nodes sorted by name.
    found = sorted(os.path.basename(p) for p in glob.glob(os.path.join(glob.escape(src), pattern)))
    names += found
for name in names:
    shutil.copyfile(os.path.join(src, name), real(virtual + "/" + name))
out = Converter(Env()).convert([Node(virtual + "/" + n) for n in names])
with io.open(real(out), "rb") as fp:
    sys.stdout.buffer.write(fp.read())
shutil.rmtree(root)
