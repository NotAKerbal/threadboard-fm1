import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { Board } from '../bridge/board.ts';
import { makeServer } from '../bridge/server.ts';

test('simulator actions use the real board state and reject other browser origins', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const server=makeServer(board,true);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  try {
    const slot=board.view.slots.find(s=>s.status==='completed')!;
    const payload={action:'select',key:slot.key,token:slot.token};
    const denied=await fetch(base+'/api/action',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(denied.status,403);
    const ok=await fetch(base+'/api/action',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(ok.status,200);
    const state=await fetch(base+'/api/state').then(r=>r.json()) as {selected:number};assert.equal(state.selected,slot.key);
    const rebound=await new Promise<number|undefined>((resolve,reject)=>{get(base+'/api/state',{headers:{host:'example.com'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(rebound,403);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
