import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../bridge/board.ts';

test('completed threads with queued follow-up tasks still flash and expose their finished result', async () => {
  const board=new Board(null,'unused',true);await board.refresh();
  const slot=board.view.slots.find(s=>s.status==='completed')!;
  const thread=board.snapshot!.threads.find(t=>t.id===slot.threadId)!;
  thread.pendingBackgroundTasks=[{}];
  await board.act({action:'select',key:slot.key,token:slot.token});
  assert.equal(board.view.slots[slot.key]!.state,'attention');
  assert.equal(board.view.result?.threadId,thread.id);
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
  await board.refresh();assert.equal(board.view.result?.text,'No final response is available. Press PLAY to open this thread in T3.');
  thread.pendingRuntimeRequest={id:'pending',kind:'user_input'};
  await board.refresh();assert.equal(board.view.result,null);
  thread.pendingRuntimeRequest=null;
  await board.act({action:'settle',key:slot.key,token:slot.token});
  assert.equal(board.view.result,null);
});
