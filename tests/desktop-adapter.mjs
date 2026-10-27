import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect,questionRequest,validAnswers} from '../bridge/desktop-adapter.js';
import {DesktopSource} from '../bridge/desktop.ts';
import {T3Client} from '../bridge/t3.ts';
import {Board} from '../bridge/board.ts';
import {makeServer} from '../bridge/server.ts';
import {demoSnapshot} from '../bridge/demo.ts';

test('desktop previews and final results load from projections when shell messages are absent',async()=>{
 const original=globalThis.fetch,snap=demoSnapshot();
 const target=snap.threads.find(t=>t.status==='completed');snap.threads=[target];
 target.latestRunId='latest-run';target.latestVisibleMessage=null;
 const final={id:'final',runId:'latest-run',role:'assistant',text:'The saved final response from T3.',streaming:false,updatedAt:'2026-10-26T10:00:00.000Z'};
 const projection={messages:[{...final,id:'old',runId:'old-run',text:'Old result'},final],turnItems:[]};
 const shell={status:'live',snapshot:{_tag:'Some',value:snap}},catalog={entries:new Map([['remote',{target:{label:'Remote'}}]])};
 let sent,reads=0;
 globalThis.fetch=async(url,options)=>{if(url.endsWith('/desktop/snapshot'))sent=JSON.parse(options.body);return Response.json(url.endsWith('/attach')?{token:'test'}:{commands:[]});};
 try{
  await connect({registry:{get:a=>a==='catalog'?catalog:shell},connections:{catalogValueAtom:'catalog'},shells:{stateValueAtom:id=>id},readProjection:async()=>{reads++;return projection;},dispatchCommand:{}},'http://test');
  const thread=sent.environments[0].snapshot.threads[0];
  assert.equal(thread.latestVisibleMessage?.text,final.text);
  assert.equal(thread.latestAssistantMessage?.text,final.text);
  assert.equal(reads,1);
 }finally{globalThis.threadboardDesktop?.stop();globalThis.fetch=original;}
});

test('desktop adapter sends existing machines and dispatches through their authenticated runtime',async()=>{
  const source=new DesktopSource(new T3Client(),'local'),board=new Board(null,'unused',true),server=makeServer(board,true,source);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,fetchOriginal=globalThis.fetch;
  const snap=demoSnapshot(),target=snap.threads[0];target.updatedAt={toJSON(){return '2026-10-26T10:00:00.000Z';}};
  const catalog={entries:new Map([['remote',{target:{label:'Already connected remote'}}]])};
  const shell={status:'live',snapshot:{_tag:'Some',value:snap}};
  const registry={get:atom=>atom==='catalog'?catalog:shell},calls=[];
  globalThis.fetch=(url,options)=>fetchOriginal(url,{...options,headers:{...options.headers,origin:'t3code://app'}});
  try{
    await connect({registry,connections:{catalogValueAtom:'catalog'},shells:{stateValueAtom:id=>id},dispatchCommand:{async run(r,command){assert.equal(r,registry);calls.push(command);target.settledOverride='settled';snap.snapshotSequence++;return {_tag:'Success',value:{sequence:snap.snapshotSequence}};}}},base);
    const first=await source.snapshot();assert.equal(first.environments[0].label,'Already connected remote');assert.equal(first.threads[0].updatedAt,'2026-10-26T10:00:00.000Z');
    await source.dispatch({type:'thread.settle',threadId:first.threads[0].id});
    assert.equal(calls.length,1);assert.equal(calls[0].environmentId,'remote');assert.equal(calls[0].input.threadId,target.id);
    assert.equal((await source.snapshot()).threads[0].settledOverride,'settled');
  }finally{globalThis.threadboardDesktop?.stop();globalThis.fetch=fetchOriginal;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await source.close();}
});

test('remote answers use a fresh projection; edited questions and approval requests cannot be answered',async()=>{
 for(const changed of [false,true]){
  const source=new DesktopSource(new T3Client(),'local'),board=new Board(null,'unused',true),server=makeServer(board,true,source);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,original=globalThis.fetch;
  const snap=demoSnapshot(),target=snap.threads.find(t=>t.pendingRuntimeRequest);snap.threads=[target];target.pendingRuntimeRequest.kind='user_input';
  const projection={runtimeRequests:[{id:target.pendingRuntimeRequest.id,kind:'user_input',status:'pending',responseCapability:{type:'live'}}],turnItems:[{type:'user_input_request',requestId:target.pendingRuntimeRequest.id,questions:structuredClone(target.questionRequest.questions)}]};
  const shell={status:'live',snapshot:{_tag:'Some',value:snap}},catalog={entries:new Map([['remote',{target:{label:'Remote'}}]])},registry={get:a=>a==='catalog'?catalog:shell},calls=[];let reads=0;
  globalThis.fetch=(url,options)=>original(url,{...options,headers:{...options.headers,origin:'t3code://app'}});
  try{
   await connect({registry,connections:{catalogValueAtom:'catalog'},shells:{stateValueAtom:id=>id},readProjection:async()=>{reads++;return structuredClone(projection);},dispatchCommand:{async run(r,c){calls.push(c);projection.runtimeRequests[0].status='resolved';target.pendingRuntimeRequest=null;snap.snapshotSequence++;return {_tag:'Success',value:{sequence:snap.snapshotSequence}};}}},base);
   const t=(await source.snapshot()).threads[0],q=t.questionRequest;assert(q);
   const answers={direction:'Keyboard controls',checks:['Browser','MIDI']};assert(validAnswers(q,answers));assert(!validAnswers(q,{...answers,direction:'Invented option'}));
   if(changed)projection.turnItems[0].questions[0].options[0].description='Question changed on another device';
   const result=source.dispatch({type:'runtime-request.respond',threadId:t.id,requestId:q.id,answers,questionSignature:JSON.stringify(q)});
   if(changed){await assert.rejects(result,/did not apply/);assert.equal(calls.length,0);}else{await result;assert.equal(calls.length,1);assert.equal(calls[0].environmentId,'remote');assert.equal(calls[0].input.threadId,target.id);assert.deepEqual(calls[0].input.answers,answers);assert(!('questionSignature'in calls[0].input));}
   assert(reads>=2);
   projection.runtimeRequests[0].kind='command_execution';assert.equal(questionRequest(projection,q.id),null);
  }finally{globalThis.threadboardDesktop?.stop();globalThis.fetch=original;server.closeAllConnections();await new Promise(r=>server.close(r));await source.close();}
 }
});

test('desktop approvals confirm provider decisions and reject changed or resolved requests',async()=>{
 for(const outcome of ['accept','decline','changed','resolved']){
  const source=new DesktopSource(new T3Client(),'local'),board=new Board(null,'unused',true),server=makeServer(board,true,source);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,original=globalThis.fetch;
  const snap=demoSnapshot(),target=snap.threads[0];snap.threads=[target];target.pendingRuntimeRequest={id:'approval',kind:'command'};
  const projection={runtimeRequests:[{id:'approval',kind:'command',status:'pending',responseCapability:{type:'live'}}],turnItems:[{type:'approval_request',requestId:'approval',prompt:'Run npm test?',options:[{decision:'accept',label:'Approve once'},{decision:'decline',label:'Deny'}]}]};
  const shell={status:'live',snapshot:{_tag:'Some',value:snap}},catalog={entries:new Map([['remote',{target:{label:'Remote'}}]])},calls=[];
  const registry={get:a=>a==='catalog'?catalog:shell};
  globalThis.fetch=(url,options)=>original(url,{...options,headers:{...options.headers,origin:'t3code://app'}});
  try{
   await connect({registry,connections:{catalogValueAtom:'catalog'},shells:{stateValueAtom:id=>id},readProjection:async()=>structuredClone(projection),dispatchCommand:{async run(r,c){calls.push(c);target.pendingRuntimeRequest=null;projection.runtimeRequests[0].status='resolved';snap.snapshotSequence++;return {_tag:'Success',value:{sequence:snap.snapshotSequence}};}}},base);
   const thread=(await source.snapshot()).threads[0],request=thread.questionRequest;assert.equal(request.kind,'approval');
   if(outcome==='changed')projection.turnItems[0].prompt='Run a different command?';
   if(outcome==='resolved')projection.runtimeRequests[0].status='resolved';
   const result=source.dispatch({type:'runtime-request.respond',threadId:thread.id,requestId:request.id,decision:outcome==='decline'?'decline':'accept',questionSignature:JSON.stringify(request)});
   if(['changed','resolved'].includes(outcome)){await assert.rejects(result,/did not apply/);assert.equal(calls.length,0);}
   else{await result;assert.equal(calls.length,1);assert.equal(calls[0].input.decision,outcome);assert.equal(calls[0].input.threadId,target.id);assert(!('questionSignature' in calls[0].input));assert.equal((await source.snapshot()).threads[0].pendingRuntimeRequest,null);}
  }finally{globalThis.threadboardDesktop?.stop();globalThis.fetch=original;server.closeAllConnections();await new Promise(r=>server.close(r));await source.close();}
 }
});
