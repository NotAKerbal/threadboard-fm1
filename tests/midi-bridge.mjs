import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { Board } from '../bridge/board.ts';
import { MidiBridge } from '../bridge/midi.ts';
import { frame, decodeFrame, SysExStream, PROTOCOL_VERSION } from '../bridge/protocol.ts';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+10000;while(!fn()){if(Date.now()>deadline)throw new Error('Bridge/MIDI check timed out');await sleep(30);}}
const virtual=spawn('output/threadboard-virtual-midi',[],{stdio:['pipe','pipe','inherit']});
await once(virtual.stdout,'data');
const parser=new SysExStream(),commits=[];
createInterface({input:virtual.stdout}).on('line',line=>{const msg=JSON.parse(line);for(const bytes of parser.push(msg.bytes??[])){const body=decodeFrame(bytes);if(body?.[1]===2)commits.push(body.readUInt32LE(2));}});
const board=new Board(null,'unused',true);await board.refresh();
let actions=0;const act=board.act.bind(board);board.act=async action=>{actions++;return act(action);};
const bridge=new MidiBridge(board,'output/threadboard-midi','Threadboard Test');bridge.start();
function send(bytes){virtual.stdin.write(JSON.stringify({bytes})+'\n');}
function select(session,key){const body=Buffer.alloc(16);body[0]=PROTOCOL_VERSION;body[1]=4;body.writeUInt32LE(session,2);body.writeUInt16LE(1,6);body[8]=0;body[9]=key;body.writeUInt32LE(board.view.slots[key].token,10);return frame(body);}
try{
 await until(()=>commits.length);await sleep(100);const session=commits.at(-1);
 const first=select(session,2);send(first);await until(()=>board.view.selected===2);send(first);await sleep(250);assert.equal(actions,1);
 send(frame(Buffer.from([PROTOCOL_VERSION,5])));await until(()=>commits.some(s=>s!==session));await sleep(100);
 const renewed=commits.at(-1);assert.notEqual(renewed,session);
 send(select(renewed,4));await until(()=>board.view.selected===4);assert.equal(actions,2);
 send(select(session,0));await sleep(200);assert.equal(actions,2);
 console.log('Full CoreMIDI/bridge flow passed: selection, duplicate retry, device reboot, reused sequence number, stale session rejection.');
}finally{bridge.close();virtual.kill();}
