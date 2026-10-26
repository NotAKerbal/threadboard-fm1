#!/usr/bin/env python3
"""Build Threadboard against its pinned FM-1 platform."""
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / 'vendor/fm1-base'
pin = '934e40d846d84e76e9c428d37b74bccb6192c823'
actual = subprocess.check_output(['git', '-C', str(base), 'rev-parse', 'HEAD'], text=True).strip()
if actual != pin:
    raise SystemExit('Unexpected fm1-base revision. Run scripts/bootstrap.sh.')
env = dict(os.environ)
env.setdefault('JIELI_TOOLCHAIN', str(root / '.cache/jieli/toolchain'))
env.setdefault('AC79_SDK', str(root / '.cache/ac79-sdk'))
env.setdefault('DOCKER_CONTEXT', 'colima-fm1-build')
env.setdefault('X0X_FONTSET', 'terminus')
subprocess.run([sys.executable, str(base / 'tools/build.py'), str(root / 'firmware'), *sys.argv[1:]], env=env, check=True)
