import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../bridge/board.ts';

test('every selected thread shows its latest message, including working and interrupted threads', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const slot=board.view.slots.find(s=>s.state==='working')!;
  const thread=board.snapshot!.threads.find(t=>t.id===slot.threadId)!;
  thread.latestVisibleMessage={id:'progress',role:'assistant',text:'Checking the saved thread messages now.',updatedAt:new Date().toISOString()};
  await board.act({action:'select',key:slot.key,token:slot.token});
  assert.equal(board.view.preview?.text,'Checking the saved thread messages now.');
  assert.equal(board.view.result,null);
  thread.status='interrupted';thread.activeRunId=null;
  await board.refresh();assert.equal(board.view.preview?.text,thread.latestVisibleMessage.text);
  thread.latestVisibleMessage={...thread.latestVisibleMessage,role:'user',text:'Please check persistence.'};
  await board.refresh();assert.equal(board.view.preview?.text,'Please check persistence.');
});

test('a completed foreground run still waiting for background work is not a done thread', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const slot=board.view.slots.find(s=>s.status==='completed')!;
  const thread=board.snapshot!.threads.find(t=>t.id===slot.threadId)!;
  const result=()=>board.view.result;
  thread.pendingBackgroundTasks=[{}];
  await board.act({action:'select',key:slot.key,token:slot.token});
  assert.equal(board.view.slots[slot.key]!.state,'working');
  assert(board.view.slots[slot.key]!.detail.startsWith('Waiting for work to finish'));
  assert.equal(result(),null);
  thread.pendingBackgroundTasks=[];
  await board.refresh();
  assert.equal(board.view.slots[slot.key]!.state,'attention');
  assert.equal(result()?.threadId,thread.id);
  thread.activityRunStatus='waiting';
  await board.refresh();
  assert.equal(board.view.slots[slot.key]!.state,'working');assert.equal(result(),null);
  thread.activityRunStatus=null;thread.activeRunId='still-active';
  await board.refresh();
  assert.equal(board.view.slots[slot.key]!.state,'working');assert.equal(result(),null);
});

test('finished results are readable after visits, preserve filenames, and clear on settlement', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const slot=board.view.slots.find(s=>s.status==='completed')!;
  const thread=board.snapshot!.threads.find(t=>t.id===slot.threadId)!;
  thread.latestVisibleMessage!.text='## Finished\n**Updated** `result_file.ts`.\n- Tests passed.\n- Review [the change](https://example.com/change) before settling.';
  await board.act({action:'select',key:slot.key,token:slot.token});
  assert.equal(board.view.result?.threadId,thread.id);
  assert.equal(board.view.result?.text,'Finished Updated result_file.ts. Tests passed. Review the change before settling.');
  assert.equal(board.view.slots[slot.key]!.state,'attention');
  await board.refresh();assert(board.view.result);
  thread.latestVisibleMessage={...thread.latestVisibleMessage!,role:'user',text:'A user message must not appear as a finished result.'};
  await board.refresh();assert.equal(board.view.result?.text,'This run has no saved final response. PLAY opens T3.');
  thread.pendingRuntimeRequest={id:'pending',kind:'user_input'};
  await board.refresh();assert.equal(board.view.result,null);
  thread.pendingRuntimeRequest=null;
  await board.act({action:'settle',key:slot.key,token:slot.token});
  assert.equal(board.view.result,null);
});
