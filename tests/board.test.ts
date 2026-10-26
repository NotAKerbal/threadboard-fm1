import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../bridge/board.ts';
import { demoSnapshot } from '../bridge/demo.ts';
import type { T3Client } from '../bridge/t3.ts';

test('settling a finished thread frees only its key; stale hardware events are rejected', async () => {
  const board=new Board(null,'unused',true); await board.refresh();
  const slot=board.view.slots.find(s=>s.status==='completed')!;
  const before=board.view.slots.map(s=>s.threadId);
  await board.act({action:'settle',key:slot.key,token:slot.token});
  assert.equal(board.view.slots[slot.key]!.threadId,null);
  assert.deepEqual(board.view.slots.filter(s=>s.key!==slot.key).map(s=>s.threadId),before.filter((_,i)=>i!==slot.key));
  await assert.rejects(board.act({action:'select',key:slot.key,token:slot.token}),/assignment changed/);
});

test('working and unanswered threads keep their assignment until they can be settled', async () => {
  const board=new Board(null,'unused',true); await board.refresh();
  const working=board.view.slots.find(s=>s.state==='working')!;
  await assert.rejects(board.act({action:'settle',key:working.key,token:working.token}),/Finish or stop/);
  await board.act({action:'stop',key:working.key,token:working.token});
  assert.equal(board.view.slots[working.key]!.threadId,working.threadId);
  await board.act({action:'settle',key:working.key,token:working.token});
  assert.equal(board.view.slots[working.key]!.threadId,null);
});

test('next attention opens a waiting thread without clearing its question', async () => {
  const board=new Board(null,'unused',true); await board.refresh();
  const question=board.view.slots.find(s=>s.status==='waiting')!;
  await board.act({action:'select',key:question.key,token:question.token});
  assert.equal(board.view.slots[question.key]!.state,'attention');
  const current=board.view.slots[board.view.selected]!;
  await board.act({action:'next',key:current.key,token:current.token});
  assert.notEqual(board.view.selected,question.key);
  assert.equal(board.view.slots[question.key]!.state,'attention');
  assert.equal(board.view.slots[board.view.selected]!.state,'attention');
});

test('failed or unconfirmed live settlement never frees the key; offline data preserves it', async () => {
  const dir=mkdtempSync(join(tmpdir(),'threadboard-'));
  try {
    const snap=demoSnapshot(); let failing=false, offline=false; const commands: Record<string,unknown>[]=[];
    const fake={environmentId:'test',snapshot:async()=>{if(offline)throw new Error('Offline');return structuredClone(snap);},openThread:async()=>{},dispatch:async(c:Record<string,unknown>)=>{commands.push(c);if(failing)throw new Error('Command rejected');}} as unknown as T3Client;
    const board=new Board(fake,dir);await board.refresh();
    const slot=board.view.slots.find(s=>s.status==='completed')!;
    failing=true;await assert.rejects(board.act({action:'settle',key:slot.key,token:slot.token}),/rejected/);
    assert.equal(board.view.slots[slot.key]!.token,slot.token);
    failing=false;await assert.rejects(board.act({action:'settle',key:slot.key,token:slot.token}),/not confirmed/);
    assert.equal(commands[0]!.type,'thread.settle');
    offline=true;await board.refresh();assert.equal(board.view.connected,false);assert.equal(board.view.slots[slot.key]!.threadId,slot.threadId);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
