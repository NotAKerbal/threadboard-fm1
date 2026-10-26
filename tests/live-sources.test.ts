import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Board } from '../bridge/board.ts';
import { CodexSource } from '../bridge/codex.ts';
import { ClaudeSource } from '../bridge/claude.ts';
import { captureClaudeEvent, readState, sessionPath } from '../bridge/claude-live.ts';
import { sourceFixture } from './source-fixtures.ts';

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error('Live transition did not arrive.');
}

test('shared Codex sessions stream, ask questions, confirm answers once, and stop the current turn', async () => {
  const f = await sourceFixture(), source = new CodexSource(f.codex, f.state, f.cli);
  await writeFile(join(f.codex, 'live.json'), JSON.stringify({ status: 'active', turnStatus: 'inProgress', question: true }));
  await f.startLive();
  const board = new Board(source, f.state);
  const view = () => board.view;
  try {
    await board.refresh();
    assert.equal(view().integration?.mode, 'live');
    assert.equal(view().capabilities?.stop, true);
    const selected = view().slots[view().selected]!;
    assert.equal(selected.state, 'attention');
    assert.equal(view().question?.text, 'Which path?');
    const token = view().question!.token;
    await board.act({ action: 'choose', key: 1, token });
    await board.act({ action: 'confirm', key: view().selected, token: view().question!.token });
    assert.equal(view().question, null);
    assert.equal(view().slots[selected.key]!.state, 'working');
    assert.equal(view().preview?.text, 'A live streamed response');
    await assert.rejects(board.act({ action: 'confirm', key: selected.key, token }), /question changed/);
    await board.act({ action: 'stop', key: selected.key, token: selected.token });
    assert.equal(view().slots[selected.key]!.status, 'interrupted');
    assert.equal(view().slots[selected.key]!.threadId, selected.threadId);
    const requests = (await readFile(join(f.codex, 'requests.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s) as { method?: string; result?: unknown; params?: { threadId: string; turnId: string } });
    assert.equal(requests.filter(r => !r.method && r.result).length, 1);
    assert(requests.some(r => r.method === 'turn/interrupt' && r.params?.turnId === 'turn1'));
    assert(requests.filter(r => r.method === 'thread/resume').every(r => r.params?.threadId === 'first'));
    assert(!requests.some(r => ['turn/start', 'thread/start'].includes(r.method ?? '')));
    await f.stopLive();
    await until(async () => !source.capabilities.stop);
    await board.refresh();
    assert.equal(view().connected, true); assert.equal(view().integration?.mode, 'history');
    assert.equal(view().question, null); assert.equal(view().slots[selected.key]!.token, selected.token);
    await assert.rejects(source.dispatch({ type: 'runtime-request.respond', threadId: selected.threadId }), /shared Codex/);
  } finally { await source.close(); await f.cleanup(); }
});

test('Claude hooks track real lifecycle events, streaming, permission waits, answers, background work, and completion across restarts', async () => {
  const f = await sourceFixture(), source = new ClaudeSource(f.claude, f.state), board = new Board(source, f.state);
  const view = () => board.view;
  const base = { session_id: 'claude-session', cwd: "/work/user's project" };
  const event = (name: string, fields: Record<string, unknown> = {}) => captureClaudeEvent(source.liveDir, { ...base, hook_event_name: name, ...fields }, process.pid);
  try {
    await board.refresh();
    assert.equal(view().integration?.mode, 'hooks');
    assert.match(view().integration!.setupCommand!, /--settings/);
    await event('UserPromptSubmit', { prompt_id: 'new-turn' });
    await event('MessageDisplay', { message_id: 'live-message', index: 0, delta: 'Live work ' });
    await event('MessageDisplay', { message_id: 'live-message', index: 1, delta: 'in progress' });
    await board.refresh();
    const slot = view().slots.find(s => s.threadId === base.session_id)!;
    assert.equal(slot.state, 'working'); assert.equal(view().preview?.text, 'Live work in progress');
    assert.equal(view().integration?.mode, 'live');
    await event('PermissionRequest', { tool_use_id: 'permission' }); await board.refresh();
    assert.equal(view().slots[slot.key]!.state, 'attention'); assert.equal(view().question, null);
    await event('PostToolUse'); await board.refresh();
    assert.equal(view().slots[slot.key]!.state, 'working');
    const question = event('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question1', tool_input: { questions: [{ header: 'Choice', question: 'Which path?', multiSelect: false, options: [{ label: 'Local', description: 'Local work' }, { label: 'Remote', description: 'Remote work' }] }] } });
    await until(async () => !!(await readState(sessionPath(source.liveDir, base.session_id)))?.pending);
    await board.refresh(); assert(view().question);
    const oldToken = view().question!.token;
    await board.act({ action: 'choose', key: 1, token: oldToken });
    const confirming = board.act({ action: 'confirm', key: slot.key, token: view().question!.token });
    const output = await question as { hookSpecificOutput: { updatedInput: { answers: Record<string, string> } } };
    await event('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question1' });
    await confirming;
    assert.deepEqual(output.hookSpecificOutput.updatedInput.answers, { 'Which path?': 'Local' });
    assert.equal(view().question, null);
    await assert.rejects(board.act({ action: 'confirm', key: slot.key, token: oldToken }), /question changed/);
    await event('Stop', { last_assistant_message: 'Foreground done; waiting for background work.', background_tasks: [{ id: 'bg', status: 'running' }] });
    await board.refresh(); assert.equal(view().slots[slot.key]!.state, 'working'); assert.equal(view().result, null);
    await assert.rejects(board.act({ action: 'settle', key: slot.key, token: slot.token }), /Finish or stop/);
    await event('Stop', { last_assistant_message: 'All work is done.', background_tasks: [] });
    await event('Notification', { notification_type: 'idle_prompt' });
    await board.refresh(); assert.equal(view().slots[slot.key]!.status, 'completed'); assert.equal(view().result?.text, 'All work is done.');
    await board.act({ action: 'settle', key: slot.key, token: slot.token });
    await source.close();
    const restart = new ClaudeSource(f.claude, f.state), restored = new Board(restart, f.state);
    await restored.refresh(); assert(!restored.view.slots.some(s => s.threadId === base.session_id));
    await restart.close();
    await event('UserPromptSubmit', { prompt_id: 'another-turn' });
    await board.refresh(); assert(view().slots.some(s => s.threadId === base.session_id && s.state === 'working'));
    await captureClaudeEvent(source.liveDir, { ...base, hook_event_name: 'UserPromptSubmit' }, 2147483646);
    await board.refresh(); assert.equal(board.snapshot?.threads.find(t => t.id === base.session_id)?.status, 'interrupted');
  } finally { await source.close(); await f.cleanup(); }
});

test('Claude agent JSON supports foreground status and safely stops only background sessions', async () => {
  const f = await sourceFixture();
  const { chmod } = await import('node:fs/promises');
  const cli = join(f.root, 'fake-claude.mjs'), registry = join(f.claude, 'registry.json');
  await writeFile(registry, JSON.stringify([
    { id: 'job-1', sessionId: 'claude-session', cwd: '/work/project', kind: 'background', startedAt: Date.now(), state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' },
    { sessionId: 'foreground', cwd: '/work/project', kind: 'interactive', startedAt: Date.now(), pid: process.pid, status: 'busy' },
  ]));
  await writeFile(cli, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const path=join(process.env.CLAUDE_CONFIG_DIR,'registry.json');
const entries=JSON.parse(readFileSync(path,'utf8'));
if(process.argv[2]==='agents')process.stdout.write(JSON.stringify(entries));
else if(process.argv[2]==='stop'){const entry=entries.find(s=>s.id===process.argv[3]);entry.state='stopped';delete entry.status;writeFileSync(path,JSON.stringify(entries));}
else process.exit(1);
`);
  await chmod(cli, 0o700);
  const source = new ClaudeSource(f.claude, f.state, cli), board = new Board(source, f.state);
  try {
    await board.refresh();
    const background = board.view.slots.find(s => s.threadId === 'claude-session')!;
    const foreground = board.view.slots.find(s => s.threadId === 'foreground')!;
    assert.equal(background.detail.startsWith('Approval waiting'), true);
    assert.equal(foreground.state, 'working');
    await assert.rejects(source.dispatch({ type: 'thread.stop', threadId: 'foreground' }), /background session/);
    await board.act({ action: 'stop', key: background.key, token: background.token });
    assert.equal(board.view.slots[background.key]!.status, 'interrupted');
    await board.act({ action: 'select', key: foreground.key, token: foreground.token });
    assert.equal(board.view.capabilities?.stop, false);
    await assert.rejects(board.act({ action: 'stop', key: foreground.key, token: foreground.token }), /no live stop/);
    const token = board.view.slots[background.key]!.token;
    await writeFile(f.transcript, 'incompatible transcript format\n');
    await board.refresh();
    assert.equal(board.view.connected, false);
    assert.equal(board.view.slots[background.key]!.token, token);
  } finally { await source.close(); await f.cleanup(); }
});
