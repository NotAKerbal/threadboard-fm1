import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {chmod,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {T3Client} from '../bridge/t3.ts';
import {DesktopSource} from '../bridge/desktop.ts';
import {Board} from '../bridge/board.ts';
import {demoSnapshot} from '../bridge/demo.ts';
import {sourceFixture} from './source-fixtures.ts';

test('local T3 loads approvals, confirms native decisions, and rechecks a changed request',async()=>{
 const f=await sourceFixture(),snapshot=demoSnapshot(),thread=snapshot.threads[0]!;
 snapshot.threads=[thread];thread.pendingRuntimeRequest={id:'approval',kind:'command'};
 const projection={runtimeRequests:[{id:'approval',kind:'command',status:'pending',responseCapability:{type:'live'}}],turnItems:[{type:'approval_request',requestId:'approval',prompt:'Run npm test?'}]};
 const commands:Record<string,unknown>[]=[];
 const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  const path=req.url!;
  res.end(JSON.stringify(path==='/.well-known/t3/environment'?{environmentId:'local',orchestrationProtocolVersion:2}:path==='/api/orchestration/shell'?snapshot:path.startsWith('/api/orchestration/threads/')?{projection}:{ticket:'fixture'}));
 });
 const ws=new WebSocketServer({server});
 ws.on('connection',socket=>socket.on('message',body=>{
  const frame=JSON.parse(String(body)) as { _tag:string;id:string;payload:Record<string,unknown> };
  if(frame._tag!=='Request')return;
  commands.push(frame.payload);thread.pendingRuntimeRequest=null;projection.runtimeRequests[0]!.status='resolved';snapshot.snapshotSequence++;
  socket.send(JSON.stringify({_tag:'Exit',requestId:frame.id,exit:{_tag:'Success',value:{sequence:snapshot.snapshotSequence}}}));
 }));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');
 await mkdir(join(f.root,'userdata'));
 await writeFile(join(f.root,'userdata/server-runtime.json'),JSON.stringify({origin:`http://127.0.0.1:${address.port}`}));
 const cli=join(f.root,'t3.mjs');await writeFile(cli,`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({sessionId:'fixture',token:'fixture',expiresAt:'2099-01-01T00:00:00Z'}));\n`);await chmod(cli,0o700);
 const client=new T3Client(cli,f.root),source=new DesktopSource(client,'local'),b=new Board(source,f.state);
 try{
  for(const decision of ['accept','decline']){
   thread.pendingRuntimeRequest={id:projection.runtimeRequests[0]!.id,kind:'command'};projection.runtimeRequests[0]!.status='pending';
   await b.refresh();assert.equal(b.view.question?.kind,'approval');
   await b.act({action:'choose',key:decision==='accept'?1:3,token:b.view.question!.token});
   await b.act({action:'confirm',key:b.view.selected,token:b.view.question!.token});
   assert.equal(b.view.question,null);assert.equal(commands.at(-1)!.decision,decision);assert(!('questionSignature' in commands.at(-1)!));
   // A distinct request after resolution must not inherit the prior submission lock.
   projection.runtimeRequests[0]!.id+='-next';projection.turnItems[0]!.requestId=projection.runtimeRequests[0]!.id;
   thread.pendingRuntimeRequest={id:projection.runtimeRequests[0]!.id,kind:'command'};
  }
  projection.runtimeRequests[0]!.status='pending';await b.refresh();const q=b.view.question!;
  projection.turnItems[0]!.prompt='Different command';
  await assert.rejects(client.dispatch({type:'runtime-request.respond',threadId:thread.id,requestId:q.requestId,questionSignature:JSON.stringify(b.snapshot!.threads[0]!.questionRequest),decision:'accept'}),/changed/);
  assert.equal(commands.length,2);
 }finally{await source.close();for(const socket of ws.clients)socket.terminate();await new Promise<void>(r=>ws.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
