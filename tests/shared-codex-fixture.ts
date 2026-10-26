import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { RpcMessage } from '../bridge/codex-rpc.ts';

export async function sharedCodexFixture(home: string): Promise<() => Promise<void>> {
  const path = join(home, 'app-server-control/app-server-control.sock');
  await mkdir(join(home, 'app-server-control'), { recursive: true });
  const server = createServer(), sockets = new WebSocketServer({ server });
  const livePath = join(home, 'live.json');
  const state = () => JSON.parse(readFileSync(livePath, 'utf8')) as { status: string; turnStatus: string; question: boolean };
  const thread = (id: string) => ({ id, cwd: '/work/project', name: 'Codex ' + id, preview: 'Fix things', createdAt: 1793016000, updatedAt: 1793016060, source: 'cli', status: id === 'first' ? { type: state().status, activeFlags: state().question ? ['waitingOnUserInput'] : [] } : { type: 'notLoaded' } });
  sockets.on('connection', socket => {
    const emit = (value: unknown) => socket.send(JSON.stringify(value));
    socket.on('message', text => {
      const r = JSON.parse(String(text)) as RpcMessage;
      appendFileSync(join(home, 'requests.jsonl'), String(text) + '\n');
      if (!r.method) { const s = state(); s.question = false; writeFileSync(livePath, JSON.stringify(s)); emit({ method: 'serverRequest/resolved', params: { threadId: 'first', requestId: r.id } }); return; }
      if (r.id === undefined) return;
      let result: unknown;
      if (r.method === 'initialize') result = {};
      else if (r.method === 'thread/list') result = r.params?.cursor ? { data: [thread('second')], nextCursor: null } : { data: [thread('first')], nextCursor: 'page2' };
      else if (r.method === 'thread/read' || r.method === 'thread/resume') result = { thread: thread(String(r.params?.threadId)) };
      else if (r.method === 'thread/turns/list') result = { data: [{ id: 'turn1', status: state().turnStatus, completedAt: state().status === 'idle' ? 1793016060 : null, items: [{ type: 'agentMessage', id: 'a1', text: 'Codex saved response' }] }] };
      else if (r.method === 'turn/interrupt') {
        const s = state(); s.status = 'idle'; s.turnStatus = 'interrupted'; writeFileSync(livePath, JSON.stringify(s));
        emit({ method: 'turn/completed', params: { threadId: 'first', turn: { id: 'turn1', status: 'interrupted', completedAt: 1793016060, items: [] } } }); result = {};
      } else { emit({ id: r.id, error: { code: -32601 } }); return; }
      emit({ id: r.id, result });
      if (r.method === 'thread/resume') {
        emit({ method: 'turn/started', params: { threadId: 'first', turn: { id: 'turn1', status: 'inProgress', items: [] } } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'first', itemId: 'stream1', delta: 'A live streamed response' } });
        if (state().question) emit({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'first', turnId: 'turn1', questions: [{ id: 'q1', header: 'Choice', question: 'Which path?', options: [{ label: 'Local', description: 'Keep work local' }, { label: 'Remote', description: 'Use remote work' }] }] } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); };
}
