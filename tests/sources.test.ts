import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeSource } from '../bridge/claude.ts';
import { CodexSource } from '../bridge/codex.ts';
import { ConfiguredSource } from '../bridge/config.ts';
import type { SourceConfig } from '../bridge/config.ts';
import { Board } from '../bridge/board.ts';
import { makeServer } from '../bridge/server.ts';
import { sourceFixture as fixture } from './source-fixtures.ts';

test('Claude history reads real transcript shapes, filters subagents, preserves local settlement, and returns on new activity', async () => {
  const f = await fixture();
  try {
    const source = new ClaudeSource(f.claude, f.state);
    let snapshot = await source.snapshot();
    assert.equal(snapshot.threads.length, 1);
    const thread = snapshot.threads[0]!;
    assert.equal(thread.title, 'Offline saves');
    assert.equal(thread.latestVisibleMessage?.text, 'Saving now works offline.');
    assert.equal(thread.status, 'saved');
    assert.match(thread.resumeCommand!, /user'\\''s project/);
    assert.equal(source.capabilities.stop, false);
    await assert.rejects(source.dispatch({ type: 'thread.stop', threadId: thread.id }), /background session/);
    await source.openThread(thread.id);
    await source.dispatch({ type: 'thread.settle', threadId: thread.id });
    snapshot = await new ClaudeSource(f.claude, f.state).snapshot();
    assert.equal(snapshot.threads[0]!.settledOverride, 'settled');
    assert(snapshot.threads[0]!.lastVisitedAt);
    await writeFile(f.transcript, [...f.entries, { type: 'assistant', timestamp: '2026-10-26T12:03:00Z', message: { content: 'A new response' }, uuid: 'a2' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    snapshot = await source.snapshot();
    assert.equal(snapshot.threads[0]!.settledOverride, null);
    assert.equal(snapshot.threads[0]!.latestVisibleMessage?.text, 'A new response');
    await assert.rejects(new ClaudeSource(join(f.root, 'missing'), f.state).snapshot(), /No Claude Code history/);
    assert.equal(await readFile(f.transcript, 'utf8').then(s => s.includes('A new response')), true);
    const board = new Board(source, f.state); await board.refresh();
    assert.equal(board.view.slots.filter(s => s.threadId).length, 1);
    await unlink(f.transcript);
    await board.refresh();
    assert.equal(board.view.slots.filter(s => s.threadId).length, 0);
  } finally { await f.cleanup(); }
});

test('Codex lists every page and reads the selected saved response without resuming a session', async () => {
  const f = await fixture(), source = new CodexSource(f.codex, f.state, f.cli);
  try {
    const snapshot = await source.snapshot();
    assert.deepEqual(snapshot.threads.map(t => t.id), ['first', 'second']);
    await source.readThread(snapshot.threads[0]!);
    assert.equal(snapshot.threads[0]!.latestVisibleMessage?.text, 'Codex saved response');
    await source.openThread('first');
    await source.dispatch({ type: 'thread.settle', threadId: 'first' });
    const settled = await source.snapshot();
    assert.equal(settled.threads[0]!.settledOverride, 'settled');
    assert.equal(settled.threads[0]!.latestVisibleMessage?.text, 'Codex saved response');
    const requests = (await readFile(join(f.codex, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string });
    assert(requests.every(r => ['initialize', 'initialized', 'thread/list', 'thread/turns/list'].includes(r.method)));
  } finally { await source.close(); await f.cleanup(); }
});

test('dashboard setup switches among three sources, persists the choice, and keeps each source’s key assignments', async () => {
  const f = await fixture();
  const config: SourceConfig = { provider: 't3', homes: { t3: join(f.root, 'missing-t3'), codex: f.codex, claude: f.claude } };
  const source = new ConfiguredSource(config, f.state, { codexCli: f.cli });
  const board = new Board(source, f.state);
  await board.refresh(); assert.equal(board.view.connected, false);
  const server = makeServer(board, false, () => source.desktop, source);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, origin = base) => fetch(base + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/config').then(r => r.json()) as SourceConfig).provider, 't3');
    assert.equal((await post({ ...config, provider: 'claude' }, 'https://other.example')).status, 403);
    assert.equal((await post({ ...config, provider: 'invalid' })).status, 400);
    assert.equal(source.get().provider, 't3');
    assert.equal((await post({ ...config, provider: 'claude' })).status, 200);
    assert.equal(board.view.connected, true);
    const claude = board.view.slots.find(s => s.threadId)!;
    assert.equal(claude.title, 'Offline saves');
    assert.match(board.view.preview!.text, /offline/);
    assert.equal((await post({ ...config, provider: 'codex' })).status, 200);
    assert(board.view.slots.some(s => s.threadId === 'first'));
    await assert.rejects(board.act({ action: 'select', key: claude.key, token: claude.token }), /assignment changed/);
    assert.equal((await post({ ...config, provider: 'claude' })).status, 200);
    assert.equal(board.view.slots[claude.key]!.token, claude.token);
    assert.deepEqual(await ConfiguredSource.read(f.state), { ...config, provider: 'claude' });
    const restarted = new ConfiguredSource(await ConfiguredSource.read(f.state), f.state);
    const restored = new Board(restarted, f.state); await restored.refresh();
    assert.equal(restored.view.slots[claude.key]!.threadId, claude.threadId);
    assert.equal(restored.view.slots[claude.key]!.token, claude.token);
    await restarted.close();
    assert.equal((await post({ ...config, homes: { ...config.homes, claude: 'relative/path' } })).status, 400);
    assert.equal(source.get().provider, 'claude');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await source.close(); await f.cleanup(); }
});
