#!/usr/bin/env python3
"""Inspect an FM-1 by default; --flash explicitly starts the interactive installer."""
import argparse
import subprocess
import sys
from pathlib import Path

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--flash',action='store_true')
parser.add_argument('--port')
args=parser.parse_args()
installer=root/'vendor/fm1-base/tools/fm1_install.py'
package=root/'output/threadboard.fwsc'
extra=['--port',args.port] if args.port else []
try:
    import mido
    import rtmidi
except ImportError:
    raise SystemExit('Use the local installer environment: .cache/installer/bin/python scripts/install-firmware.py\nPrepare it with: python3 -m venv .cache/installer && .cache/installer/bin/pip install -r scripts/installer-requirements.txt')
if not args.flash:
    result=subprocess.run([sys.executable,str(installer),'--info',*extra])
    raise SystemExit(result.returncode)
if not package.exists():raise SystemExit('Build and package output/threadboard.fwsc first.')
print('Threadboard replaces the synthesizer firmware. Export any sounds/settings you want to keep first.')
print('The standard FM-1 installer will identify the unit, ask before writing, and verify its identity afterward.')
print('Keep power and USB connected. Stock recovery firmware is in output/stock-FM-1_015.fwsc.')
raise SystemExit(subprocess.run([sys.executable,str(installer),str(package),*extra]).returncode)
