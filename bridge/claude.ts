import { createReadStream, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { HistorySource, savedThread, shellQuote } from './history.ts';
import { answerPath, claudeLiveDir, digest, liveStates, ownerAlive, prepareClaudeHooks, readState, sessionPath, writeExclusive } from './claude-live.ts';
import type { IntegrationStatus, ShellSnapshot, Thread } from './types.ts';

interface Entry {
  type?: string; sessionId?: string; cwd?: string; timestamp?: string; uuid?: string;
  isSidechain?: boolean; isMeta?: boolean; customTitle?: string; summary?: string;
  message?: { role?: string; content?: string | { type: string; text?: string }[] };
}
const run = promisify(execFile);
interface NativeSession { id?: string; sessionId: string; cwd: string; kind: string; name?: string; state?: string; status?: string; waitingFor?: string; pid?: number; startedAt: number }

function text(content: NonNullable<Entry['message']>['content']): string {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') : '';
}

export class ClaudeSource extends HistorySource {
  readonly home: string;
  readonly liveDir: string;
  readonly cli: string;
  onChange?: () => void;
  private stateDir: string;
  private settings = '';
  private prepared = false;
  private watcher: FSWatcher | null = null;
  private notify: NodeJS.Timeout | null = null;
  private tracked = 0;
  private native: NativeSession[] = [];
  private nativeAvailable = false;
  private cache = new Map<string, { stamp: string; thread: Thread | null }>();
  constructor(home: string, stateDir: string, cli = 'claude') { super('claude', home, stateDir); this.home = home; this.stateDir = stateDir; this.liveDir = claudeLiveDir(stateDir, home); this.cli = cli; }
  override get capabilities() { return { stop: this.nativeAvailable && this.native.some(s => s.kind === 'background' && ['working', 'blocked'].includes(s.state ?? '')), answer: true }; }
  get integration(): IntegrationStatus {
    return { mode: this.tracked || this.native.length ? 'live' : 'hooks', detail: this.native.length ? 'Live status from Claude agent view. REC stops background sessions. Resume with tracking for streaming previews and choice answers. Approvals stay in Claude.' : this.tracked ? `${this.tracked} Claude session${this.tracked === 1 ? '' : 's'} tracked live. Answer choice questions here; use Claude to stop foreground work or approve permissions.` : 'Resume a thread with the command below, or start Claude with live tracking. Existing settings stay in place.', setupCommand: `CLAUDE_CONFIG_DIR=${shellQuote(this.home)} ${shellQuote(this.cli)} --settings ${shellQuote(this.settings)}` };
  }
  private async sessions(): Promise<NativeSession[] | null> {
    try {
      const { stdout } = await run(this.cli, ['agents', '--json', '--all'], { env: { ...process.env, CLAUDE_CONFIG_DIR: this.home }, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const entries: unknown = JSON.parse(stdout);
      if (!Array.isArray(entries)) return null;
      return entries.filter(s => s && typeof s.cwd === 'string' && typeof s.kind === 'string' && (typeof s.sessionId === 'string' || typeof s.id === 'string')).map(s => ({ ...s, sessionId: s.sessionId ?? `claude-job:${s.id}` })) as NativeSession[];
    } catch { return null; } // Older CLIs can still use history and hook tracking.
  }
  private async read(path: string, updatedAt: string): Promise<Thread | null> {
    const input = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    // Propagate stream errors; readline does not forward them itself.
    input.on('error', () => lines.close());
    let thread: Thread | null = null, title = '', summary = '', invalid = false;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let entry: Entry;
        try { entry = JSON.parse(line) as Entry; }
        catch { invalid = true; continue; } // A writer may still be appending its final line.
        if (!entry || typeof entry !== 'object') { invalid = true; continue; }
        if (entry.isSidechain) return null;
        if (typeof entry.customTitle === 'string') title = entry.customTitle;
        if (entry.type === 'summary' && typeof entry.summary === 'string') summary = entry.summary;
        if (!thread && typeof entry.sessionId === 'string' && typeof entry.cwd === 'string') {
          const createdAt = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : updatedAt;
          thread = savedThread(entry.sessionId, entry.cwd, '', createdAt, updatedAt);
          thread.resumeCommand = `cd ${shellQuote(entry.cwd)} && CLAUDE_CONFIG_DIR=${shellQuote(this.home)} claude --resume ${shellQuote(entry.sessionId)}`;
        }
        if (!thread || entry.isMeta || !['user', 'assistant'].includes(entry.type ?? '')) continue;
        const message = text(entry.message?.content).trim();
        if (!message) continue;
        // Internal command/XML records are not user-authored thread titles.
        if (!thread.title && entry.type === 'user' && !message.startsWith('<')) thread.title = message.replace(/\s+/g, ' ').slice(0, 120);
        const at = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : updatedAt;
        thread.latestVisibleMessage = { id: entry.uuid ?? `${entry.type}-${at}`, role: entry.type!, text: message, updatedAt: at };
        if (entry.type === 'assistant') thread.latestAssistantMessage = thread.latestVisibleMessage;
        else thread.latestUserAuthoredMessageAt = at;
      }
      if (input.errored) throw input.errored;
      if (!thread && invalid) throw new Error('Could not read Claude Code transcript format.');
      if (thread) {
        thread.title = title || summary || thread.title || `Claude session ${thread.id.slice(0, 8)}`;
        thread.messageReadError = invalid;
      }
      return thread;
    } finally { lines.close(); input.destroy(); }
  }
  private async history(): Promise<ShellSnapshot> {
    const root = join(this.home, 'projects');
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error(`No Claude Code history at ${root}. Check its home directory or start a Claude Code session first.`), { code: 'NO_CLAUDE_HISTORY' });
      throw error;
    }
    const threads: Thread[] = [];
    const present = new Set<string>();
    for (const project of projects.filter(p => p.isDirectory())) {
      const dir = join(root, project.name);
      for (const file of await readdir(dir, { withFileTypes: true })) {
        // Subagent transcripts live in nested directories and must not take keys.
        if (!file.isFile() || !file.name.endsWith('.jsonl') || file.name.startsWith('agent-')) continue;
        const path = join(dir, file.name);
        present.add(path);
        try {
          const info = await stat(path), stamp = `${info.mtimeMs}:${info.size}`;
          let cached = this.cache.get(path);
          if (!cached || cached.stamp !== stamp || cached.thread?.messageReadError) {
            cached = { stamp, thread: await this.read(path, info.mtime.toISOString()) };
            this.cache.set(path, cached);
          }
          if (cached.thread) threads.push(structuredClone(cached.thread));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    for (const path of this.cache.keys()) if (!present.has(path)) this.cache.delete(path);
    const unique = [...new Map(threads.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map(t => [t.id, t])).values()];
    return { schemaVersion: 2, snapshotSequence: 0, threads: unique, archivedThreads: [], projects: [...new Set(unique.map(t => t.projectId))].map(id => ({ id, title: basename(id) || id })) };
  }
  async load(): Promise<ShellSnapshot> {
    if (!this.prepared) {
      const setup = await prepareClaudeHooks(this.stateDir, this.home); this.settings = setup.settings;
      await mkdir(join(this.liveDir, 'sessions'), { recursive: true, mode: 0o700 });
      this.watcher = watch(join(this.liveDir, 'sessions'), () => {
        if (!this.notify) this.notify = setTimeout(() => { this.notify = null; this.onChange?.(); }, 150);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      this.watcher.unref();
      this.prepared = true;
    }
    const [states, sessions] = await Promise.all([liveStates(this.liveDir), this.sessions()]);
    this.nativeAvailable = sessions !== null; this.native = sessions ?? [];
    let snapshot: ShellSnapshot;
    try { snapshot = await this.history(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'NO_CLAUDE_HISTORY' || !states.length && !this.native.length) throw error;
      // Hooks arrive before the asynchronous transcript writer on new sessions.
      snapshot = { schemaVersion: 2, snapshotSequence: 0, threads: [], archivedThreads: [], projects: [] };
    }
    this.tracked = 0;
    for (const session of this.native) {
      let thread = snapshot.threads.find(t => t.id === session.sessionId);
      if (!thread) {
        const at = Number.isFinite(session.startedAt) ? new Date(session.startedAt).toISOString() : new Date().toISOString();
        thread = savedThread(session.sessionId, session.cwd, session.name || `Claude ${session.sessionId.slice(0, 8)}`, at, at);
        snapshot.threads.push(thread); snapshot.projects.push({ id: session.cwd, title: basename(session.cwd) || session.cwd });
      }
      thread.live = true; thread.canStop = !!session.id && session.kind === 'background' && ['working', 'blocked'].includes(session.state ?? '');
      thread.latestRunId = `${session.id ?? session.pid}:${session.startedAt}`;
      thread.settlementKey = `${thread.latestRunId}:${session.state ?? session.status}:${thread.latestUserAuthoredMessageAt ?? ''}`;
      if (session.state === 'blocked' || session.status === 'waiting') { thread.status = 'waiting'; thread.activeRunId = thread.latestRunId; thread.pendingRuntimeRequest = { id: `${session.id ?? session.pid}:input`, kind: /permission|sandbox/.test(session.waitingFor ?? '') ? 'approval' : 'user-input' }; }
      else if (session.state === 'working' || session.status === 'busy') { thread.status = 'running'; thread.activeRunId = thread.latestRunId; }
      else if (session.state === 'done') thread.status = 'completed';
      else if (session.state === 'failed') thread.status = 'failed';
      else if (session.state === 'stopped') thread.status = 'interrupted';
      else thread.status = 'idle';
      if (['completed', 'failed'].includes(thread.status)) thread.latestRunCompletedAt = thread.updatedAt;
    }
    for (const state of states) {
      let thread = snapshot.threads.find(t => t.id === state.sessionId);
      if (thread?.latestUserAuthoredMessageAt && Date.parse(thread.latestUserAuthoredMessageAt) > Date.parse(state.observedAt)) continue;
      const alive = ownerAlive(state.ownerPid);
      if (!thread) {
        thread = savedThread(state.sessionId, state.cwd, `Claude ${state.sessionId.slice(0, 8)}`, state.observedAt, state.observedAt);
        snapshot.threads.push(thread);
        snapshot.projects.push({ id: state.cwd, title: basename(state.cwd) || state.cwd });
      }
      if (state.status === 'idle') continue;
      if (alive) this.tracked++;
      thread.live = alive;
      thread.activeRunId = null; thread.pendingRuntimeRequest = null; thread.pendingBackgroundTasks = [];
      thread.updatedAt = state.observedAt; thread.status = state.status;
      thread.latestRunId = state.runId;
      thread.settlementKey = `${state.runId}:${state.status}`;
      if (alive && ['running', 'waiting'].includes(state.status)) {
        thread.activeRunId = state.runId;
        thread.pendingBackgroundTasks = state.backgroundTasks;
        thread.pendingRuntimeRequest = state.waiting ?? null;
        if (state.pending && ownerAlive(state.pending.hookPid) && state.pending.expiresAt > Date.now()) thread.questionRequest = state.pending.request;
        // A quiet or disconnected hook must not display an endless running light.
        if (Date.now() - Date.parse(state.observedAt) > 30 * 60_000) thread.unavailable = true;
      } else if (['running', 'waiting'].includes(state.status)) thread.status = 'interrupted';
      if (['completed', 'failed'].includes(thread.status)) thread.latestRunCompletedAt = state.observedAt;
      thread.latestAssistantMessage = state.message ?? null;
      if (state.message) thread.latestVisibleMessage = state.message;
      else if (thread.latestVisibleMessage?.role === 'assistant' && Date.parse(thread.latestVisibleMessage.updatedAt) < Date.parse(state.observedAt)) thread.latestVisibleMessage = null;
    }
    for (const thread of snapshot.threads) {
      const session = this.native.find(s => s.sessionId === thread.id);
      thread.resumeCommand = session?.id && thread.id.startsWith('claude-job:')
        ? `CLAUDE_CONFIG_DIR=${shellQuote(this.home)} ${shellQuote(this.cli)} attach ${shellQuote(session.id)}`
        : `cd ${shellQuote(thread.projectId)} && CLAUDE_CONFIG_DIR=${shellQuote(this.home)} ${shellQuote(this.cli)} --settings ${shellQuote(this.settings)} --resume ${shellQuote(thread.id)}`;
    }
    return snapshot;
  }
  override async dispatch(command: Record<string, unknown>): Promise<void> {
    if (command.type === 'thread.stop') {
      const session = (await this.sessions())?.find(s => s.sessionId === command.threadId && !!s.id && s.kind === 'background' && ['working', 'blocked'].includes(s.state ?? ''));
      if (!session) throw new Error('Only a running Claude background session can be stopped here.');
      try { await run(this.cli, ['stop', session.id!], { env: { ...process.env, CLAUDE_CONFIG_DIR: this.home }, timeout: 10000 }); }
      catch { throw new Error('Claude did not confirm stopping this background session.'); }
      const after = await this.sessions();
      if (!after) throw new Error('Could not verify Claude’s stopped state. Check the provider.');
      const stopped = after.find(s => s.id === session.id);
      if (stopped && !['stopped', 'done', 'failed'].includes(stopped.state ?? '')) throw new Error('Claude has not confirmed the stopped state yet.');
      return;
    }
    if (command.type !== 'runtime-request.respond') return super.dispatch(command);
    const threadId = String(command.threadId), state = await readState(sessionPath(this.liveDir, threadId));
    const pending = state?.pending;
    if (!state || !ownerAlive(state.ownerPid) || !pending || !ownerAlive(pending.hookPid) || pending.expiresAt <= Date.now() || pending.request.id !== command.requestId || JSON.stringify(pending.request) !== command.questionSignature) throw new Error('This Claude question is no longer available.');
    const answers = command.answers as Record<string, string | string[]>;
    for (const question of pending.request.questions) {
      const value = answers[question.id], values = Array.isArray(value) ? value : [value];
      if (!values.length || values.some(v => typeof v !== 'string' || !question.options.some(o => o.label === v))) throw new Error('Invalid Claude answer.');
    }
    await mkdir(join(this.liveDir, 'answers'), { recursive: true, mode: 0o700 });
    await writeExclusive(answerPath(this.liveDir, pending.request.id), { requestId: pending.request.id, runId: state.runId, signature: command.questionSignature, answers });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const ack = JSON.parse(await readFile(join(this.liveDir, 'acks', `${digest(pending.request.id)}.json`), 'utf8')) as { requestId: string; runId: string };
        if (ack.requestId === pending.request.id && ack.runId === state.runId) { await rm(join(this.liveDir, 'acks', `${digest(pending.request.id)}.json`), { force: true }); return; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await delay(50);
    }
    throw new Error('Claude did not confirm the answer. Check the provider before retrying.');
  }
  override async close(): Promise<void> {
    this.watcher?.close(); this.watcher = null;
    if (this.notify) clearTimeout(this.notify); this.notify = null;
    this.prepared = false;
  }
}
