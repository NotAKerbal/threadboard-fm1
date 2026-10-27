#!/usr/bin/env python3
"""Collect the installable firmware, notices and a reproducible build manifest."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

root=Path(__file__).resolve().parents[1]
out=root/'output'
out.mkdir(exist_ok=True)
shutil.copy2(root/'firmware/build/threadboard.fwsc',out/'threadboard.fwsc')
notices=out/'notices';notices.mkdir(exist_ok=True)
for source,name in [
    ('LICENSE','Threadboard-MIT.txt'),('THIRD_PARTY.md','THIRD_PARTY.md'),
    ('vendor/fm1-base/LICENSE','fm1-base-MPL-2.0.txt'),
    ('vendor/fm1-base/LICENSING.md','fm1-base-LICENSING.md'),
    ('vendor/fm1-base/CREDITS.md','fm1-base-CREDITS.md'),
    ('vendor/fm1-base/bsp/NOTICE','felucca-bsp-NOTICE.txt'),
    ('vendor/fm1-base/bsp/LICENSING.md','felucca-bsp-LICENSING.md'),
    ('vendor/fm1-base/assets/fonts/Terminus-LICENSE.txt','Terminus-LICENSE.txt'),
    ('.cache/ac79-sdk/LICENSE','JieLi-Apache-2.0.txt')]:
    shutil.copy2(root/source,notices/name)
manifest={
    'name':'Threadboard','version':'0.1.0','device':'M-VAVE FM-1','identity':'FM-1_98700',
    'fm1_base':subprocess.check_output(['git','-C',str(root/'vendor/fm1-base'),'rev-parse','HEAD'],text=True).strip(),
    'bsp':subprocess.check_output(['git','-C',str(root/'vendor/fm1-base/bsp'),'rev-parse','HEAD'],text=True).strip(),
    't3_protocol':2,'wire_protocol':6,
    'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [out/'threadboard.fwsc',out/'threadboard-midi',out/'stock-FM-1_015.fwsc']},
}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
