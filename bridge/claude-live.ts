import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { QuestionRequest, Thread } from './types.ts';

export interface ClaudeLiveState {
  sessionId: string; cwd: string; ownerPid: number; observedAt: string; runId: string;
  status: string; message?: Thread['latestVisibleMessage']; backgroundTasks?: unknown[];
  waiting?: { id: string; kind: string };
  pending?: { request: QuestionRequest; expiresAt: number; input: Record<string, unknown>; hookPid: number };
  submittedQuestion?: string;
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const claudeLiveDir = (stateDir: string, home: string): string => join(stateDir, `claude-live-${digest(home)}`);
export const sessionPath = (dir: string, id: string): string => join(dir, 'sessions', `${digest(id)}.json`);
export const answerPath = (dir: string, id: string): string => join(dir, 'answers', `${digest(id)}.json`);
export function ownerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export async function writeAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export async function writeExclusive(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await link(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function readState(path: string): Promise<ClaudeLiveState | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as ClaudeLiveState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; }
}
async function update(dir: string, id: string, edit: (state: ClaudeLiveState | null) => ClaudeLiveState): Promise<ClaudeLiveState> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, `${digest(id)}.lock`), deadline = Date.now() + 3000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 10000) await rm(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() >= deadline) throw new Error('Claude event lock timed out.');
      await delay(20);
    }
  }
  try { const state = edit(await readState(sessionPath(dir, id))); await writeAtomic(sessionPath(dir, id), state); return state; }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function captureClaudeEvent(dir: string, event: Record<string, unknown>, ownerPid: number): Promise<Record<string, unknown>> {
  const id = event.session_id, cwd = event.cwd, name = event.hook_event_name;
  if (typeof id !== 'string' || !id || typeof cwd !== 'string' || typeof name !== 'string' || event.agent_id) return {};
  const now = new Date().toISOString();
  let acknowledged: string | undefined;
  let questions: QuestionRequest | undefined;
  const input = event.tool_input as Record<string, unknown> | undefined;
  if (name === 'PreToolUse' && event.tool_name === 'AskUserQuestion' && Array.isArray(input?.questions)) {
    const qs = input.questions as { header: string; question: string; multiSelect?: boolean; options: { label: string; description: string }[] }[];
    if (qs.length > 0 && qs.length <= 20 && qs.every(q => typeof q.header === 'string' && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length > 0 && q.options.length <= 100 && q.options.every(o => typeof o.label === 'string' && typeof o.description === 'string'))) {
      questions = { id: typeof event.tool_use_id === 'string' ? event.tool_use_id : randomUUID(), responseCapability: 'live', questions: qs.map((q, i) => ({ id: String(i), header: q.header, question: q.question, multiSelect: q.multiSelect === true, options: q.options })) };
    }
  }
  const state = await update(dir, id, previous => {
    const state: ClaudeLiveState = previous && previous.ownerPid === ownerPid ? previous : { sessionId: id, cwd, ownerPid, observedAt: now, runId: randomUUID(), status: 'idle' };
    state.cwd = cwd;
    // Idle reminders are not questions and must not resurrect completed work.
    if (name === 'Notification' && !['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'].includes(String(event.notification_type))) return state;
    state.observedAt = now;
    if (name === 'UserPromptSubmit') {
      state.runId = typeof event.prompt_id === 'string' ? event.prompt_id : randomUUID();
      state.status = 'running'; state.pending = undefined; state.waiting = undefined; state.message = null; state.backgroundTasks = []; state.submittedQuestion = undefined;
    } else if (name === 'PreToolUse' || name === 'PostToolUse' || name === 'PostToolUseFailure') {
      state.status = 'running';
      if (name !== 'PreToolUse' || !state.pending) state.waiting = undefined;
      if (questions) { questions.revision = state.runId; state.pending = { request: questions, input: input!, expiresAt: Date.now() + 580000, hookPid: process.pid }; state.waiting = { id: questions.id, kind: 'user-input' }; }
      else if (event.tool_name === 'AskUserQuestion' && name !== 'PreToolUse') {
        if (name === 'PostToolUse' && state.submittedQuestion === event.tool_use_id) acknowledged = state.submittedQuestion;
        state.submittedQuestion = undefined; state.pending = undefined; state.waiting = undefined;
      }
    } else if (name === 'PermissionRequest' || name === 'Notification') {
      if (state.status !== 'completed' && state.status !== 'failed') {
        state.waiting = { id: String(event.tool_use_id ?? `${state.runId}:permission`), kind: name === 'PermissionRequest' || event.notification_type === 'permission_prompt' ? 'approval' : 'user-input' };
      }
    } else if (name === 'MessageDisplay' && typeof event.delta === 'string' && typeof event.message_id === 'string') {
      const prefix = state.message?.id === event.message_id && event.index !== 0 ? state.message.text : '';
      state.message = { id: event.message_id, role: 'assistant', text: (prefix + event.delta).slice(0, 32000), updatedAt: now };
    } else if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') {
      state.pending = undefined; state.waiting = undefined;
      state.backgroundTasks = Array.isArray(event.background_tasks) ? event.background_tasks : [];
      if (name === 'Stop') state.status = state.backgroundTasks.length ? 'waiting' : 'completed';
      if (name === 'StopFailure') state.status = 'failed';
      if (name === 'SessionEnd' && !['completed', 'failed'].includes(state.status)) { state.status = 'interrupted'; state.backgroundTasks = []; }
      if (typeof event.last_assistant_message === 'string') state.message = { id: `${state.runId}:final`, role: 'assistant', text: event.last_assistant_message.slice(0, 32000), updatedAt: now };
    }
    return state;
  });
  if (acknowledged) await writeAtomic(join(dir, 'acks', `${digest(acknowledged)}.json`), { requestId: acknowledged, runId: state.runId });
  if (!questions || state.pending?.request.id !== questions.id) return {};
  const request = questions;
  // Only the question hook waits. Every status hook returns immediately.
  try {
    while (Date.now() < state.pending.expiresAt && ownerAlive(ownerPid)) {
      const current = await readState(sessionPath(dir, id));
      if (current?.ownerPid !== ownerPid || current.runId !== state.runId || current.pending?.request.id !== request.id) return {};
      type Response = { requestId: string; runId: string; signature: string; answers: Record<string, string | string[]> };
      let response: Response | null = null;
      try { response = JSON.parse(await readFile(answerPath(dir, request.id), 'utf8')) as Response; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (response && (response.requestId !== request.id || response.runId !== state.runId || response.signature !== JSON.stringify(request))) { await rm(answerPath(dir, request.id), { force: true }); continue; }
      if (response) {
        const submitted = response;
        const answers: Record<string, string> = {};
        for (const q of request.questions) {
          const value = submitted.answers[q.id], values = Array.isArray(value) ? value : [value];
          if (!values.length || values.some(v => typeof v !== 'string' || !q.options.some(o => o.label === v))) throw new Error('Invalid question answer.');
          answers[q.question] = values.join(', ');
        }
        await update(dir, id, s => { if (s?.ownerPid !== ownerPid || s.runId !== state.runId || s.pending?.request.id !== request.id) throw new Error('Question expired.'); s.pending = undefined; s.submittedQuestion = request.id; s.waiting = undefined; s.status = 'running'; s.observedAt = new Date().toISOString(); return s; });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers } } };
      }
      await delay(100);
    }
    return {};
  } finally {
    await rm(answerPath(dir, request.id), { force: true });
    await update(dir, id, s => { if (!s) throw new Error('Session disappeared.'); if (s.ownerPid === ownerPid && s.runId === state.runId && s.pending?.request.id === request.id) s.pending = undefined; return s; });
  }
}

export async function prepareClaudeHooks(stateDir: string, home: string): Promise<{ dir: string; settings: string }> {
  const dir = claudeLiveDir(stateDir, home), settings = join(dir, 'settings.json');
  const script = fileURLToPath(import.meta.url);
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'MessageDisplay', 'Stop', 'StopFailure', 'SessionEnd'];
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: process.execPath, args: [script, '--events-dir', dir], timeout: event === 'PreToolUse' ? 600 : 5 }] }]]));
  await writeAtomic(settings, { hooks });
  return { dir, settings };
}
export async function liveStates(dir: string): Promise<ClaudeLiveState[]> {
  let files: string[];
  try { files = await readdir(join(dir, 'sessions')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const states = await Promise.all(files.filter(f => f.endsWith('.json')).map(f => readState(join(dir, 'sessions', f))));
  return states.filter((s): s is ClaudeLiveState => !!s && typeof s.sessionId === 'string' && typeof s.cwd === 'string' && Number.isFinite(Date.parse(s.observedAt)) && typeof s.runId === 'string');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const i = process.argv.indexOf('--events-dir'), dir = i < 0 ? undefined : process.argv[i + 1];
    if (dir) {
      let body = ''; for await (const chunk of process.stdin) { body += String(chunk); if (body.length > 2 * 1024 * 1024) throw new Error('Hook input too large.'); }
      const output = await captureClaudeEvent(dir, JSON.parse(body) as Record<string, unknown>, process.ppid);
      process.stdout.write(JSON.stringify(output));
    }
  } catch { process.stdout.write('{}'); } // Observation must not prevent Claude from running.
}
