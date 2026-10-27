import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Board } from '../bridge/board.ts';
import { CodexSource } from '../bridge/codex.ts';
import { ClaudeSource } from '../bridge/claude.ts';
import { captureClaudeEvent, readState, sessionPath } from '../bridge/claude-live.ts';
import { approvalQuestion } from '../bridge/thread-messages.js';
import { questionRequest } from '../bridge/desktop-adapter.js';
import { demoSnapshot } from '../bridge/demo.ts';
import { sourceFixture } from './source-fixtures.ts';

async function until(check: () => Promise<boolean>) {
  for(let n=0;n<200;n++){if(await check())return;await delay(20);}
  throw new Error('Approval did not arrive.');
}
const options=[{label:'Approve once',description:'Allow this action.',value:'accept'},{label:'Deny',description:'Do not allow this action.',value:'decline'}];

test('approvals require a choice and PLAY, rotate tokens after changes, and lock uncertain submissions',async()=>{
  const f=await sourceFixture(),snap=demoSnapshot(),thread=snap.threads[0]!;
  thread.pendingRuntimeRequest={id:'approval',kind:'command'};
  thread.questionRequest=approvalQuestion('approval','revision1','Run npm test?',options);
  snap.threads=[thread];const commands:Record<string,unknown>[]=[];
  const b=new Board({environmentId:'test',snapshot:async()=>structuredClone(snap),openThread:async()=>{},dispatch:async c=>{commands.push(c);throw Error('Unconfirmed');}},f.state);
  try{
    await b.refresh();assert.equal(b.view.question?.kind,'approval');assert.equal(b.view.question.canSubmit,false);
    await assert.rejects(b.act({action:'confirm',key:b.view.selected,token:b.view.question.token}),/Choose/);
    await b.act({action:'choose',key:1,token:b.view.question.token});const token=b.view.question!.token;
    thread.questionRequest!.revision='revision2';await b.refresh();
    await assert.rejects(b.act({action:'confirm',key:b.view.selected,token}),/changed/);
    await b.act({action:'choose',key:3,token:b.view.question!.token});
    await assert.rejects(b.act({action:'confirm',key:b.view.selected,token:b.view.question!.token}),/Unconfirmed/);
    assert.equal(commands.length,1);assert.equal(commands[0]!.decision,'decline');assert(!('answers' in commands[0]!));
    await b.refresh();assert(b.view.question!.submitted);
    await assert.rejects(b.act({action:'confirm',key:b.view.selected,token:b.view.question!.token}),/already sent/);
    thread.unavailable=true;await b.refresh();assert.equal(b.view.question,null);
  }finally{await f.cleanup();}
});

test('T3 approval extraction preserves provider choices and refuses resolved, non-live, or unreadable requests',()=>{
  const projection={runtimeRequests:[{id:'a',kind:'command',status:'pending',responseCapability:{type:'live'}}],turnItems:[{type:'approval_request',requestId:'a',prompt:'Run npm test?',options:[{decision:'accept',label:'Approve once'},{decision:'decline',label:'Deny'}]}]};
  const request=questionRequest({projection},'a');assert.equal(request?.kind,'approval');assert.equal(request.questions[0]!.options[0]!.value,'accept');
  projection.turnItems[0]!.prompt='Changed command';assert.notEqual(JSON.stringify(request),JSON.stringify(questionRequest(projection,'a')));
  projection.runtimeRequests[0]!.status='resolved';assert.equal(questionRequest(projection,'a'),null);
  projection.runtimeRequests[0]!.status='pending';projection.runtimeRequests[0]!.responseCapability.type='not_resumable';assert.equal(questionRequest(projection,'a'),null);
  for(const text of ['x'.repeat(1101),'Run a command on /tmp/秘密','x\n'.repeat(45)])assert.equal(approvalQuestion('a','rev',text,options)!.questions[0]!.options.length,0);
});

for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'])for(const decision of ['accept','decline'])test(`Codex ${method} confirms ${decision} once through the shared socket`,async()=>{
  const f=await sourceFixture();await writeFile(join(f.codex,'live.json'),JSON.stringify({status:'active',turnStatus:'inProgress',approval:method}));await f.startLive();
  const source=new CodexSource(f.codex,f.state,f.cli),b=new Board(source,f.state);
  try{
    await b.refresh();const q=b.view.question!;assert.equal(q.kind,'approval');assert.equal(q.canSubmit,false);
    assert.deepEqual(q.choices.map(c=>c.label),method.includes('permissions')?['Approve this turn','Deny']:['Approve once','Deny']);
    await b.act({action:'choose',key:decision==='accept'?1:3,token:q.token});
    await b.act({action:'confirm',key:b.view.selected,token:b.view.question!.token});assert.equal(b.view.question,null);
    await assert.rejects(b.act({action:'confirm',key:b.view.selected,token:q.token}),/changed/);
    const replies=(await readFile(join(f.codex,'requests.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s) as {method?:string;result?:unknown}).filter(r=>!r.method&&r.result);
    assert.equal(replies.length,1);
    assert.deepEqual(replies[0]!.result,method.includes('permissions')?{permissions:decision==='accept'?{network:{enabled:true}}:{},scope:'turn'}:{decision});
  }finally{await source.close();await f.cleanup();}
});

for(const decision of ['accept','decline'])test(`Claude permission hook returns ${decision} and waits for provider activity`,async()=>{
  const f=await sourceFixture(),source=new ClaudeSource(f.claude,f.state),b=new Board(source,f.state);
  const base={session_id:'claude-session',cwd:'/work/project'};
  const event=(name:string,fields:Record<string,unknown>={})=>captureClaudeEvent(source.liveDir,{...base,hook_event_name:name,...fields},process.pid);
  try{
    await b.refresh();await event('UserPromptSubmit');
    const tool={tool_name:'Bash',tool_input:{command:'echo test'}};
    await event('PreToolUse',{...tool,tool_use_id:'tool1'});
    // PermissionRequest intentionally has no tool_use_id, matching the real CLI.
    const hook=event('PermissionRequest',tool);
    await until(async()=>!!(await readState(sessionPath(source.liveDir,base.session_id)))?.pending);
    await event('Notification',{notification_type:'permission_prompt'});
    await b.refresh();assert.equal(b.view.question?.kind,'approval');
    await b.act({action:'choose',key:decision==='accept'?1:3,token:b.view.question!.token});
    const confirming=b.act({action:'confirm',key:b.view.selected,token:b.view.question!.token});
    const output=await hook;
    assert.deepEqual(output,{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:decision==='accept'?{behavior:'allow'}:{behavior:'deny',message:'Denied from Threadboard.'}}});
    if(decision==='accept')await event('PostToolUse',{...tool,tool_use_id:'tool1'});
    else await event('MessageDisplay',{message_id:'reply',index:0,delta:'Permission denied.'});
    await confirming;assert.equal(b.view.question,null);
  }finally{await source.close();await f.cleanup();}
});
