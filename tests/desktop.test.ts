import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSource } from '../bridge/desktop.ts';
import type { DesktopEnvironment } from '../bridge/desktop.ts';
import { T3Client } from '../bridge/t3.ts';
import { Bindings } from '../bridge/bindings.ts';
import { demoSnapshot } from '../bridge/demo.ts';
import { Board } from '../bridge/board.ts';
import { makeServer } from '../bridge/server.ts';

function machines(): DesktopEnvironment[] {
  const s=demoSnapshot();s.threads=s.threads.slice(0,1);
  return [{id:'local',label:'This Mac',connected:true,snapshot:structuredClone(s)},{id:'remote',label:'Jeffrey',connected:true,snapshot:structuredClone(s)}];
}
test('desktop machines share fixed keys, route duplicate thread IDs, and keep offline assignments',async()=>{
  const source=new DesktopSource(new T3Client(),'local'), store=new Bindings(null,'local');
  const env=machines();
  const localOnly=structuredClone(env);localOnly.pop();source.receive(localOnly);
  const first=store.reconcile(await source.snapshot()).slots.find(s=>s.threadId)!;
  source.receive(env);const combined=store.reconcile(await source.snapshot()).slots;
  assert.equal(combined[first.key]!.token,first.token);
  const remote=combined.find(s=>s.threadId?.startsWith('remote::'))!;
  assert.equal(remote.machine,'Jeffrey');
  const promise=source.dispatch({type:'thread.stop',threadId:remote.threadId});
  const commands=source.commands();assert.equal(commands.length,1);assert.equal(commands[0]!.environmentId,'remote');assert.equal(commands[0]!.input.threadId,env[1]!.snapshot!.threads[0]!.id);
  assert.deepEqual(source.commands(),[]);source.result(commands[0]!.id,true);await promise;
  env[1]!.connected=false;env[1]!.snapshot!.threads[0]!.settledOverride='settled';source.receive(env);
  const offline=store.reconcile(await source.snapshot()).slots;
  assert.equal(offline[remote.key]!.token,remote.token);assert.equal(offline[remote.key]!.state,'unavailable');
  await assert.rejects(source.dispatch({type:'thread.stop',threadId:remote.threadId}),/disconnected/);
  env[1]!.connected=true;source.receive(env);
  assert.equal(store.reconcile(await source.snapshot()).slots[remote.key]!.threadId,null);
  assert.equal(store.reconcile(await source.snapshot()).slots[first.key]!.token,first.token);
  await source.close();
});

test('desktop channel rejects other origins and requires its session capability',async()=>{
  const source=new DesktopSource(new T3Client(),'local'),board=new Board(null,'unused',true),server=makeServer(board,true,source);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  try {
    for(const origin of ['http://evil.example','null',base])assert.equal((await fetch(base+'/desktop/attach',{method:'POST',headers:{origin}})).status,403);
    const attach=await fetch(base+'/desktop/attach',{method:'POST',headers:{origin:'t3code://app'}});assert.equal(attach.status,200);
    const {token}=await attach.json() as {token:string};
    const send=(cap:string)=>fetch(base+'/desktop/snapshot',{method:'POST',headers:{origin:'t3code://app','content-type':'application/json','x-threadboard-desktop':cap},body:JSON.stringify({environments:machines()})});
    assert.equal((await send('wrong')).status,403);assert.equal((await send(token)).status,200);
    assert.equal((await source.snapshot()).threads.length,2);
    assert.throws(()=>source.receive([{...machines()[0]!,snapshot:{...demoSnapshot(),schemaVersion:7}}]),/Unsupported/);
  }
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await source.close();}
});
