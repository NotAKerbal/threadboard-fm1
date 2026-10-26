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
if '--host' not in sys.argv:
    bsp = base / 'bsp'
    if subprocess.check_output(['git', '-C', str(bsp), 'rev-parse', 'HEAD'], text=True).strip() != '2cd696a2b94341077303e9132bb4be3d0a87ebcf':
        raise SystemExit('Unexpected felucca-bsp revision. Run scripts/bootstrap.sh.')
    # Slow the BSP's native smooth fade from 1.13 to 4.5 seconds for sleeping keys.
    header = bsp / 'boards/fm1/fm1_input.h'
    source = header.read_text()
    original = '#define FM1_LED_BREATH_FRAMES 1024u'
    modified = '#define FM1_LED_BREATH_FRAMES 4096u'
    if original in source:
        header.write_text(source.replace(original, modified, 1))
    elif modified not in source:
        raise SystemExit('Unsupported BSP LED timing. Refusing to patch it.')
env = dict(os.environ)
env.setdefault('JIELI_TOOLCHAIN', str(root / '.cache/jieli/toolchain'))
env.setdefault('AC79_SDK', str(root / '.cache/ac79-sdk'))
env.setdefault('DOCKER_CONTEXT', 'colima-fm1-build')
env.setdefault('X0X_FONTSET', 'terminus')
subprocess.run([sys.executable, str(base / 'tools/build.py'), str(root / 'firmware'), *sys.argv[1:]], env=env, check=True)
