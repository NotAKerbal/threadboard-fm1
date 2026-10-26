import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bindings } from '../bridge/bindings.ts';
import { demoSnapshot } from '../bridge/demo.ts';
import { lightState, THREAD_KEYS, ANSWER_KEYS } from '../bridge/types.ts';
import type { Thread } from '../bridge/types.ts';

test('snoozed threads breathe until expiry while unavailable machines stay unavailable', () => {
  const thread=demoSnapshot().threads[0]!;
  thread.snoozedUntil='2026-10-26T10:00:00Z';
  assert.equal(lightState(thread,Date.parse('2026-10-26T09:59:59Z')).state,'snoozed');
  assert.equal(lightState(thread,Date.parse(thread.snoozedUntil)).state,'working');
  thread.unavailable=true;
  assert.equal(lightState(thread,Date.parse('2026-10-26T09:59:59Z')).state,'unavailable');
});

test('a thread keeps its key through reorder, new threads, completion and process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threadboard-'));
  try {
    const path = join(dir, 'bindings.json'), snap = demoSnapshot(), first = new Bindings(path, 'local');
    const before = first.reconcile(snap).slots.filter(s => s.threadId).map(s => [s.key, s.threadId, s.token]);
    snap.threads.reverse();
    const active = snap.threads.find(t => t.status === 'running')!; active.status = 'completed'; active.activeRunId = null;
    const extra = structuredClone(snap.threads[0]!); extra.id = 'brand-new'; extra.updatedAt = '2099-01-01T00:00:00Z'; snap.threads.push(extra);
    const after = new Bindings(path, 'local').reconcile(snap).slots;
    for (const [key, id, token] of before) { assert.equal(after[Number(key)]!.threadId, id); assert.equal(after[Number(key)]!.token, token); }
    const released = snap.threads.find(t => t.id === before[1]![1])!; released.settledOverride = 'settled';
    const freed = new Bindings(path, 'local').reconcile(snap).slots;
    assert.equal(freed[Number(before[1]![0])]!.threadId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overflow and partial snapshots cannot displace existing threads', () => {
  const snap = demoSnapshot();
  const template = snap.threads[0]!;
  snap.threads = Array.from({ length: THREAD_KEYS.length + 2 }, (_, i): Thread => ({ ...structuredClone(template), id: `thread-${String(i).padStart(2, '0')}` }));
  const store = new Bindings(null, 'local');
  const initial = store.reconcile(snap);
  assert.equal(initial.overflow, 2);
  const tokens = initial.slots.map(s => s.token), ids = initial.slots.map(s => s.threadId);
  snap.threads = snap.threads.filter(t => t.id !== ids[0]);
  const missing = store.reconcile(snap);
  assert.deepEqual(missing.slots.map(s => s.token), tokens);
  assert.equal(missing.slots[0]!.state, 'unavailable');
  const settled = structuredClone(template); settled.id = ids[0]!; settled.settledOverride = 'settled'; snap.threads.push(settled);
  const next = store.reconcile(snap);
  assert.notEqual(next.slots[0]!.threadId, ids[0]);
  assert.notEqual(next.slots[0]!.token, tokens[0]);
  assert.deepEqual(next.slots.slice(1).map(s => s.threadId), ids.slice(1));
});

test('corrupt or cross-environment state fails without replacing assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threadboard-'));
  try {
    const path=join(dir,'bindings.json'); const first=new Bindings(path,'local'); first.reconcile(demoSnapshot());
    assert.throws(()=>new Bindings(path,'other'),/Invalid/);
    writeFileSync(path,'{broken'); assert.throws(()=>new Bindings(path,'local'));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('questions override working lights and remain lit after reading the thread', () => {
  const t=demoSnapshot().threads[0]!;
  t.pendingRuntimeRequest={id:'q',kind:'user-input',blocking:false}; t.lastVisitedAt='2099-01-01T00:00:00Z';
  assert.deepEqual(lightState(t),{state:'attention',reason:'Question waiting'});
  t.pendingRuntimeRequest=null; assert.equal(lightState(t).state,'working');
});

test('completed threads keep flashing after visits until explicitly settled', () => {
  const t=demoSnapshot().threads[2]!;
  assert.equal(lightState(t).state,'attention');
  t.lastVisitedAt='2099-01-01T00:00:00Z'; assert.equal(lightState(t).state,'attention');
  assert.equal(lightState(t).reason,'Done, awaiting settlement');
  t.pendingRuntimeRequest={id:'p',kind:'permission'}; assert.equal(lightState(t).reason,'Approval waiting');
  t.pendingRuntimeRequest=null;t.settledOverride='settled';assert.equal(lightState(t).state,'idle');
});

test('visiting a completed thread keeps its key and does not retrigger its chime',()=>{
  const snap=demoSnapshot(),store=new Bindings(null,'local'),t=snap.threads.find(t=>t.status==='completed')!;
  const first=store.reconcile(snap).slots.find(s=>s.threadId===t.id)!;
  t.lastVisitedAt='2099-01-01T00:00:00Z';t.updatedAt='2099-01-01T00:00:00Z';
  const visited=store.reconcile(snap).slots[first.key]!;
  assert.equal(visited.state,'attention');assert.equal(visited.token,first.token);assert.equal(visited.attentionSerial,first.attentionSerial);
  t.latestRunId='new-completed-run';assert.notEqual(store.reconcile(snap).slots[first.key]!.attentionSerial,first.attentionSerial);
  t.settledOverride='settled';assert.equal(store.reconcile(snap).slots[first.key]!.threadId,null);
});

test('subagents never consume physical thread keys', () => {
  const snap=demoSnapshot(); snap.threads[0]!.lineage.relationshipToParent='subagent';
  const slots=new Bindings(null,'local').reconcile(snap).slots;
  assert(!slots.some(s=>s.threadId===snap.threads[0]!.id));
});

test('new attention events get durable serials while polls, visits and reconnects stay silent',()=>{
  const dir=mkdtempSync(join(tmpdir(),'threadboard-chime-'));
  try{
    const path=join(dir,'bindings.json'),snap=demoSnapshot(),store=new Bindings(path,'local');
    const target=snap.threads[0]!;target.pendingRuntimeRequest={id:'question-1',kind:'user-input'};
    const first=store.reconcile(snap).slots.find(s=>s.threadId===target.id)!;
    assert(first.attentionSerial);
    target.lastVisitedAt='2099-01-01T00:00:00Z';
    assert.equal(store.reconcile(snap).slots[first.key]!.attentionSerial,first.attentionSerial);
    const restarted=new Bindings(path,'local');
    assert.equal(restarted.reconcile(snap).slots[first.key]!.attentionSerial,first.attentionSerial);
    target.unavailable=true;restarted.reconcile(snap);target.unavailable=false;
    assert.equal(restarted.reconcile(snap).slots[first.key]!.attentionSerial,first.attentionSerial);
    target.pendingRuntimeRequest={id:'question-2',kind:'user-input'};
    assert.notEqual(restarted.reconcile(snap).slots[first.key]!.attentionSerial,first.attentionSerial);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('cached active threads from an offline machine also reserve keys until confirmed settled',()=>{
  const snap=demoSnapshot(),store=new Bindings(null,'local');
  for(const t of snap.threads){t.unavailable=true;t.machine='Offline machine';}
  const first=store.reconcile(snap).slots.filter(s=>s.threadId);
  assert(first.length>0);assert(first.every(s=>s.state==='unavailable'));
  const t=snap.threads.find(t=>t.id===first[0]!.threadId)!;t.settledOverride='settled';
  assert.equal(store.reconcile(snap).slots[first[0]!.key]!.token,first[0]!.token);
  t.unavailable=false;
  assert.equal(store.reconcile(snap).slots[first[0]!.key]!.threadId,null);
});

test('white-key migration preserves existing white positions, follows the selection and saves the old layout',()=>{
  const dir=mkdtempSync(join(tmpdir(),'threadboard-layout-'));
  try{
    const path=join(dir,'bindings.json');
    const legacy={version:1,environmentId:'local',selected:3,slots:Array.from({length:27},(_,key)=>key<10?{threadId:`old-${key}`,token:100+key}:null)};
    const original=JSON.stringify(legacy);writeFileSync(path,original);
    const store=new Bindings(path,'local');
    assert.equal(readFileSync(path+'.before-white-keys','utf8'),original);
    assert(ANSWER_KEYS.every(k=>store.saved.slots[k]===null));
    for(const key of THREAD_KEYS)if(legacy.slots[key])assert.deepEqual(store.saved.slots[key],legacy.slots[key]);
    for(const binding of legacy.slots.filter(b=>b!==null))assert(store.saved.slots.some(b=>b?.threadId===binding.threadId&&b.token===binding.token));
    assert.equal(store.saved.slots[store.saved.selected]!.threadId,'old-3');
    assert.deepEqual(new Bindings(path,'local').saved,store.saved);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('migration keeps excess existing bindings in a durable queue and fills released white keys first',()=>{
  const dir=mkdtempSync(join(tmpdir(),'threadboard-full-layout-'));
  try{
    const path=join(dir,'bindings.json');
    writeFileSync(path,JSON.stringify({version:1,environmentId:'local',selected:0,slots:Array.from({length:27},(_,key)=>({threadId:`old-${key}`,token:100+key}))}));
    const snap=demoSnapshot(),template=snap.threads[0]!;
    snap.threads=Array.from({length:27},(_,i)=>({...structuredClone(template),id:`old-${i}`}));
    const store=new Bindings(path,'local'),first=store.reconcile(snap);
    assert.equal(first.overflow,11);assert.equal(store.saved.waiting!.length,11);
    assert.equal(first.slots.filter(s=>s.threadId).length,16);
    assert(ANSWER_KEYS.every(k=>first.slots[k]!.token===0));
    snap.threads[0]!.settledOverride='settled';
    const restarted=new Bindings(path,'local'),next=restarted.reconcile(snap);
    assert.equal(next.overflow,10);assert.equal(next.slots[0]!.threadId,'old-1');assert.equal(next.slots[0]!.token,101);
    for(const key of THREAD_KEYS.slice(1))assert.equal(next.slots[key]!.token,100+key);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
