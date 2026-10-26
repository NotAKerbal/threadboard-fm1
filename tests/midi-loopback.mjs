import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { Board } from '../bridge/board.ts';
import { snapshotFrames, SysExStream } from '../bridge/protocol.ts';

const virtual=spawn('output/threadboard-virtual-midi',[],{stdio:['pipe','pipe','inherit']});
await once(virtual.stdout,'data');
const helper=spawn('output/threadboard-midi',['--name','Threadboard Test'],{stdio:['pipe','pipe','inherit']});
const parser=new SysExStream(), received=[];
const messages=createInterface({input:helper.stdout});
let linked=false;
messages.on('line',line=>{const msg=JSON.parse(line);if(msg.type==='status')linked=msg.connected;if(msg.type==='midi')received.push(...parser.push(msg.bytes));});
async function until(fn){const deadline=Date.now()+8000;while(!fn()){if(Date.now()>deadline)throw new Error('MIDI loopback timed out');await new Promise(r=>setTimeout(r,30));}}
try{
  await until(()=>linked);
  const board=new Board(null,'unused',true);await board.refresh();
  const frames=snapshotFrames(board.view,99);
  for(const bytes of frames){helper.stdin.write(JSON.stringify({bytes})+'\n');await new Promise(r=>setTimeout(r,15));}
  await until(()=>received.length===frames.length);
  assert.deepEqual(received,frames);
  virtual.stdin.end();await once(virtual,'exit');await until(()=>!linked);
  console.log(`CoreMIDI loopback passed: ${frames.length} complete frames, long SysEx packets, and endpoint disconnect detection.`);
}finally{helper.kill();virtual.kill();}
