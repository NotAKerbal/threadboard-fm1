#!/usr/bin/env python3
"""Exercise the actual C app using the bridge's wire protocol and simulated panel."""
import json
import subprocess
from pathlib import Path

root=Path(__file__).resolve().parents[1]
out=root/'output/firmware-tests'
out.mkdir(parents=True,exist_ok=True)
fixture=json.loads(subprocess.check_output(['node','tests/firmware-fixtures.ts'],cwd=root,text=True))
frames=fixture['frames']
script=['wait 100']+['inject '+f for f in frames[:-1]]+['inject '+fixture['malformed']]+[
    'wait 20','expect linked 0','inject '+frames[-1],'wait 32',
    'expect linked 1','expect slot0 101','expect slot2 102','expect slot4 103',
    'expect bright 4','expect dim 17','shot connected.png',
    'wait 450','expect bright 20','expect dim 1',
    'tapkey 4','expect action 0','expect action_token 103','expect pending 1',
    'inject '+fixture['wrongAck'],'wait 20','expect pending 1',
    'inject '+fixture['ack1'],'wait 20','expect pending 0',
    'tapkey 1','expect pending 0','expect action 0','press SAVE','tapkey 2','release SAVE','expect action 3','expect action_token 102',
    'inject '+fixture['ack2'],'wait 20','expect pending 0','expect slot2 102',
    'inject '+frames[0],'inject '+frames[1],'inject '+frames[-1],
    'wait 20','expect slot4 103','expect linked 1',
    'wait 6100','expect linked 0','expect bright 0','expect slot2 102','shot disconnected.png',
    'tapkey 0','expect action 3',
]+['inject '+f for f in fixture['renewed']]+[
    'wait 32','expect linked 1','expect slot2 102','tapkey 0','expect action 0','expect action_token 101',
    'shot reconnected.png','expect chimes 0','inject '+fixture['ack3'],'master 4096','wav chime-full.wav'
]
def inject(frames):return ['inject '+f for f in frames]
script+=inject(fixture['events'][0])+['wait 400','expect chimes 1','wavstop','wav repeated.wav']
script+=inject(fixture['events'][1])+['wait 400','expect chimes 1','wavstop','wav new-question.wav']
script+=inject(fixture['events'][2])+['wait 400','expect chimes 2','wavstop','master 0','wav muted.wav']
script+=inject(fixture['events'][3])+['wait 400','expect chimes 3','wavstop','master 2048','wav chime-half.wav']
script+=inject(fixture['events'][4])+['wait 400','expect chimes 4','wavstop']
script+=inject(fixture['questions'][0])+['wait 32','expect question 1','expect question_index 0','expect question_ready 0','tap PLAY','expect action 0','tapkey 1','expect action 5','expect action_token 1001','inject '+fixture['questionAcks'][0]]
script+=inject(fixture['questions'][1])+['wait 32','expect question_index 1','expect answer1 0','tapkey 1','expect action 5','expect action_token 1002','inject '+fixture['questionAcks'][1]]
script+=inject(fixture['questions'][2])+['wait 32','expect answer1 1','expect question_ready 1','shot question-choices.png','tap PLAY','expect action 6','expect action_token 1003','inject '+fixture['questionAcks'][2]]
path=out/'scenario.tb';path.write_text('\n'.join(script)+'\n')
expanded=[]
for line in script:
    if line.startswith('inject '):
        parts=line[7:].split();expanded.append('wire_clear')
        for i in range(0,len(parts),40):expanded.append('wire '+' '.join(parts[i:i+40]))
        expanded.append('wire_end')
    else:expanded.append(line)
path.write_text('\n'.join(expanded)+'\n')
result=subprocess.run([str(root/'firmware/build/host/threadboard_host'),str(path),str(out)],cwd=root,text=True,capture_output=True)
(out/'run.log').write_text(result.stdout+result.stderr)
print(result.stdout[-9000:]);print(result.stderr)
if result.returncode:raise SystemExit(result.returncode)
if 'unknown command' in result.stderr or 'FAIL' in result.stdout:raise SystemExit('Firmware scenario did not complete')
outgoing=[line.split(' ',1)[1] for line in result.stdout.splitlines() if line.startswith('threadboard-out ')]
check="""
import {decodeFrame,parseAction} from './bridge/protocol.ts';
const frames=JSON.parse(process.argv[1]);
const actions=frames.map(hex=>decodeFrame([...Buffer.from(hex,'hex')])).filter(b=>b&&b[1]===4);
if(actions.length!==6)throw new Error('Expected six panel commands');
const decoded=actions.map(b=>parseAction(b,b.readUInt32LE(2)));
if(decoded[0].action.action!=='select'||decoded[0].action.token!==103)throw new Error('Wrong selected thread');
if(decoded[1].action.action!=='settle'||decoded[1].action.token!==102)throw new Error('Wrong settlement binding');
if(decoded[2].action.token!==101||actions[2].readUInt32LE(2)!==77)throw new Error('Reconnect used an old session');
if(decoded[3].action.action!=='choose'||decoded[3].action.token!==1001||decoded[4].action.token!==1002||decoded[5].action.action!=='confirm'||decoded[5].action.token!==1003)throw new Error('Question actions did not carry the displayed question token');
console.log('C firmware output decoded successfully by the TypeScript bridge.');
"""
subprocess.run(['node','--input-type=module','-e',check,json.dumps(outgoing)],cwd=root,check=True)
import wave,array
def samples(name):
    with wave.open(str(out/name),'rb') as w:
        assert w.getframerate()==44100 and w.getnchannels()==2
        data=array.array('h',w.readframes(w.getnframes()))
        assert 0.38<len(data)/2/44100<0.42
        return data
full=samples('chime-full.wav');half=samples('chime-half.wav')
peak=max(map(abs,full));halfpeak=max(map(abs,half))
assert 3000<peak<5000,peak
assert abs(halfpeak/peak-0.25)<0.01,(halfpeak,peak) # MASTER uses the platform's squared volume curve.
assert max(map(abs,samples('muted.wav')))==0
assert max(map(abs,samples('repeated.wav')))==0
assert max(map(abs,samples('new-question.wav')))>3000
assert max(map(abs,full[-8000:]))==0
assert full[::2]==full[1::2]
print('Chime verified: new requests sound once, repeated snapshots stay silent, MASTER scales volume and zero mutes.')
