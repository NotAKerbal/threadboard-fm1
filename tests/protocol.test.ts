import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeFrame, frame, pack7, unpack7, snapshotFrames, SysExStream, parseAction, PROTOCOL_VERSION } from '../bridge/protocol.ts';
import { Board } from '../bridge/board.ts';

test('wire protocol round-trips all byte values and fragmented messages', () => {
  for(let n=1;n<=300;n++) {const bytes=randomBytes(n);assert.deepEqual(unpack7(pack7(bytes)),bytes);}
  const body=Buffer.from([PROTOCOL_VERSION,5]), wire=frame(body), parser=new SysExStream();
  assert.deepEqual(parser.push(wire.slice(0,4)),[]);
  const [whole]=parser.push([0xf8,...wire.slice(4)]);assert.deepEqual(decodeFrame(whole!),body);
  const bad=[...wire];bad[bad.length-2]=bad[bad.length-2]!^1;assert.equal(decodeFrame(bad),null);
});

test('a complete snapshot sends every key including empty keys, and includes persistent binding tokens', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const frames=snapshotFrames(board.view,123);assert.equal(frames.length,31);
  const raw=frames.map(f=>decodeFrame(f)!);
  assert.equal(raw[0]![1],0);assert.equal(raw.at(-1)![1],2);
  for(let i=0;i<27;i++) {assert.equal(raw[i+1]![10],i);assert.equal(raw[i+1]!.readUInt32LE(12),board.view.slots[i]!.token);}
});

test('finished results cross the MIDI link in bounded chunks and clear when selecting another thread', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const slot=board.view.slots.find(s=>s.status==='completed')!;
  const t=board.snapshot!.threads.find(t=>t.id===slot.threadId)!;
  t.latestVisibleMessage!.text='The report is ready. '.repeat(80)+'Next: review the result.';
  await board.act({action:'select',key:slot.key,token:slot.token});
  const frames=snapshotFrames(board.view,123).map(f=>decodeFrame(f)!);
  const chunks=frames.filter(b=>b[1]===7);
  assert(chunks.length>1);
  assert(chunks.every(b=>b.length<=254));
  assert(chunks.every((b,n)=>b.readUInt16LE(12)===n*240));
  const text=Buffer.concat(chunks.map(b=>b.subarray(14))).toString('ascii');
  assert(text.startsWith('The report is ready.'));
  assert(text.endsWith('Open in T3 for the full result.'));
  assert.equal(text.length,chunks[0]!.readUInt16LE(10));
  const other=board.view.slots.find(s=>s.status==='running')!;
  await board.act({action:'select',key:other.key,token:other.token});
  assert.equal(board.view.result,null);
  const empty=snapshotFrames(board.view,123).map(f=>decodeFrame(f)!).find(b=>b[1]===7)!;
  assert.equal(empty.length,14);assert.equal(empty.readUInt16LE(10),0);
});

test('commands from a prior USB session cannot act on current threads', () => {
  const body=Buffer.alloc(16);body[0]=PROTOCOL_VERSION;body[1]=4;body.writeUInt32LE(12,2);body.writeUInt16LE(7,6);body[8]=3;body[9]=4;body.writeUInt32LE(12345,10);
  assert.equal(parseAction(body,13),null);
  assert.deepEqual(parseAction(body,12),{sequence:7,action:{action:'settle',key:4,token:12345,value:0}});
});
