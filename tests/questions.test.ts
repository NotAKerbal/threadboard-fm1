import{test}from'node:test';
import assert from'node:assert/strict';
import{Board}from'../bridge/board.ts';
import{ANSWER_KEYS}from'../bridge/types.ts';
import{demoSnapshot}from'../bridge/demo.ts';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';

async function selected(){const b=new Board(null,'unused',true);await b.refresh();const s=b.view.slots.find(s=>s.status==='waiting')!;await b.act({action:'select',key:s.key,token:s.token});return b;}
test('black keys choose single and multiple answers; PLAY is required and can submit only once',async()=>{
 const b=await selected(),s=b.view.selected,q=b.view.question!;assert(q);assert.equal(q.canSubmit,false);
 await assert.rejects(b.act({action:'confirm',key:s,token:q.token}),/every required/);
 await b.act({action:'choose',key:ANSWER_KEYS[0],token:q.token});assert.equal(b.view.question!.index,1);
 const stale=q.token,q2=b.view.question!;
 await assert.rejects(b.act({action:'choose',key:ANSWER_KEYS[1],token:stale}),/changed/);
 await b.act({action:'choose',key:ANSWER_KEYS[0],token:q2.token});assert.equal(b.view.question!.canSubmit,true);
 await b.act({action:'choose',key:ANSWER_KEYS[1],token:b.view.question!.token});assert.equal(b.view.question!.choices.filter(c=>c.selected).length,2);
 await b.act({action:'choose',key:ANSWER_KEYS[0],token:b.view.question!.token});assert.equal(b.view.question!.choices.filter(c=>c.selected).length,1);
 const pending=b.snapshot!.threads.find(t=>t.id===b.view.question!.threadId)!;assert(pending.pendingRuntimeRequest);
 const submitToken=b.view.question!.token;await b.act({action:'confirm',key:s,token:submitToken});assert.equal(b.view.question,null);assert.equal(pending.pendingRuntimeRequest,null);
 await assert.rejects(b.act({action:'confirm',key:s,token:submitToken}),/changed/);
 assert(ANSWER_KEYS.every(k=>b.view.slots[k]!.token===0));
});
test('question pages and question navigation rotate tokens; switching threads or edited options rejects stale keys',async()=>{
 const b=await selected();await b.act({action:'choose',key:1,token:b.view.question!.token});
 const old=b.view.question!;await b.act({action:'page',key:b.view.selected,token:old.token,value:1});assert.equal(b.view.question!.page,1);assert.equal(b.view.question!.choices.length,1);
 await assert.rejects(b.act({action:'choose',key:1,token:old.token}),/changed/);
 await b.act({action:'choose',key:1,token:b.view.question!.token});assert.equal(b.view.question!.canSubmit,true);
 const token=b.view.question!.token;const t=b.snapshot!.threads.find(t=>t.id===b.view.question!.threadId)!;t.questionRequest!.questions[1]!.options[11]!.label='Edited option';await b.refresh();
 await assert.rejects(b.act({action:'confirm',key:b.view.selected,token}),/changed/);
 const context=b.view.question!,other=b.view.slots.find(s=>s.threadId&&s.threadId!==context.threadId)!;
 await b.act({action:'select',key:other.key,token:other.token});await assert.rejects(b.act({action:'choose',key:1,token:context.token}),/changed/);
});
test('remote-style answers use option values and keep unconfirmed submissions locked',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'question-board-'));
 try{
  const snap=demoSnapshot(),t=snap.threads.find(t=>t.pendingRuntimeRequest)!;t.questionRequest!.questions=t.questionRequest!.questions.slice(0,1);t.questionRequest!.questions[0]!.options[0]!.value='keyboard';
  const commands:Record<string,unknown>[]=[];
  const b=new Board({environmentId:'local',snapshot:async()=>structuredClone(snap),openThread:async()=>{},dispatch:async c=>{commands.push(c);throw Error('Unconfirmed command');}},dir);
  await b.refresh();const s=b.view.slots.find(s=>s.threadId===t.id)!;await b.act({action:'select',key:s.key,token:s.token});
  await b.act({action:'choose',key:1,token:b.view.question!.token});const token=b.view.question!.token;
  await assert.rejects(b.act({action:'confirm',key:s.key,token}),/Unconfirmed/);await b.refresh();
  assert.equal(commands.length,1);assert.deepEqual(commands[0]!.answers,{direction:'keyboard'});assert(t.pendingRuntimeRequest);assert.equal(b.view.question!.submitted,true);
  await assert.rejects(b.act({action:'confirm',key:s.key,token:b.view.question!.token}),/already sent/);assert.equal(commands.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
