import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HistorySource, savedThread, shellQuote } from './history.ts';
import { CodexRpc } from './codex-rpc.ts';
import type { RpcMessage } from './codex-rpc.ts';
import type { IntegrationStatus, QuestionRequest, ShellSnapshot, Thread } from './types.ts';

interface Status { type: 'notLoaded' | 'idle' | 'systemError' | 'active'; activeFlags?: string[] }
interface CodexThread { id: string; cwd: string; name?: string | null; preview: string; createdAt: number; updatedAt: number; source?: string | Record<string, unknown>; parentThreadId?: string | null; status?: Status }
interface Item { id: string; type: string; text?: string; content?: { type: string; text?: string }[] }
interface Turn { id: string; status: string; items: Item[]; completedAt?: number | null }
interface LiveThread { turnId?: string; status?: string; completedAt?: string; message?: Thread['latestVisibleMessage']; pending?: { nativeId: string | number; turnId: string; request: QuestionRequest }; approval?: string; inputId?: string }

export class CodexSource extends HistorySource {
  readonly home: string;
  readonly cli: string;
  readonly socket?: string;
  onChange?: () => void;
  private rpc: CodexRpc | null = null;
  private shared = false;
  private retrySharedAt = 0;
  private joined = new Set<string>();
  private live = new Map<string, LiveThread>();
  private notify: NodeJS.Timeout | null = null;
  private messages = new Map<string, { updatedAt: string; message: Thread['latestVisibleMessage']; assistant: Thread['latestAssistantMessage'] }>();
  constructor(home: string, stateDir: string, cli = 'codex', socket?: string) { super('codex', home, stateDir); this.home = home; this.cli = cli; this.socket = socket; }
  override get capabilities() { const live = this.shared && !!this.rpc && !this.rpc.closed; return { stop: live, answer: live }; }
  get integration(): IntegrationStatus {
    return this.shared && !this.rpc?.closed
      ? { mode: 'live', detail: 'Connected to the shared Codex server. Stop and choice answers are available for its live sessions.' }
      : { mode: 'history', detail: this.socket ? 'Saved history. The configured Codex control socket is unavailable. Check its path in Thread source settings.' : 'Saved history. Start the shared Codex server, then run or resume sessions through it. Threadboard reconnects automatically.', ...this.socket ? {} : { setupCommand: `CODEX_HOME=${shellQuote(this.home)} ${shellQuote(this.cli)} app-server daemon start` } };
  }
  private changed(): void {
    if (!this.notify) this.notify = setTimeout(() => { this.notify = null; this.onChange?.(); }, 400);
  }
  private event(message: RpcMessage): void {
    if (!this.shared) return;
    const p = message.params ?? {}, id = p.threadId;
    if (typeof id !== 'string') { this.changed(); return; }
    const live = this.live.get(id) ?? {};
    this.live.set(id, live);
    if (message.method === 'turn/started') {
      const turn = p.turn as Turn;
      live.turnId = turn.id; live.status = 'running'; live.completedAt = undefined;
      live.message = null; live.pending = undefined; live.approval = undefined; live.inputId = undefined;
      this.messages.delete(id);
    } else if (message.method === 'turn/completed') {
      const turn = p.turn as Turn;
      live.turnId = turn.id; live.status = turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed' : 'interrupted';
      live.completedAt = new Date((turn.completedAt ?? Date.now() / 1000) * 1000).toISOString();
      live.pending = undefined; live.approval = undefined; live.inputId = undefined; this.messages.delete(id);
    } else if (message.method === 'item/agentMessage/delta' && typeof p.itemId === 'string' && typeof p.delta === 'string') {
      const previous = live.message?.id === p.itemId ? live.message.text : '';
      live.message = { id: p.itemId, role: 'assistant', text: (previous + p.delta).slice(0, 32000), updatedAt: new Date().toISOString() };
    } else if (message.method === 'item/completed' && (p.item as Item)?.type === 'agentMessage') {
      const item = p.item as Item;
      live.message = { id: item.id, role: 'assistant', text: item.text ?? '', updatedAt: new Date().toISOString() };
      this.messages.delete(id);
    } else if (message.method === 'item/tool/requestUserInput' && message.id !== undefined) {
      live.inputId = String(message.id);
      const qs = p.questions as { id: string; header: string; question: string; options: { label: string; description: string }[] | null; isSecret?: boolean }[];
      if (Array.isArray(qs) && qs.length && qs.every(q => !q.isSecret && typeof q.id === 'string' && typeof q.question === 'string' && typeof q.header === 'string' && Array.isArray(q.options))) {
        live.pending = { nativeId: message.id, turnId: String(p.turnId), request: { id: String(message.id), revision: String(p.turnId), responseCapability: 'live', questions: qs.map(q => ({ id: q.id, header: q.header, question: q.question, options: q.options! })) } };
      } else live.pending = undefined;
    } else if (message.method?.includes('requestApproval') && message.id !== undefined) {
      live.approval = String(message.id);
    } else if (message.method === 'serverRequest/resolved') {
      if (live.pending?.nativeId === p.requestId) live.pending = undefined;
      if (live.approval === String(p.requestId)) live.approval = undefined;
      if (live.inputId === String(p.requestId)) live.inputId = undefined;
    }
    this.changed();
  }
  private async start(shared: boolean): Promise<void> {
    const rpc = new CodexRpc(this.cli, this.home, shared ? ['proxy', ...this.socket ? ['--sock', this.socket] : []] : [], message => this.event(message), () => {
      if (this.rpc === rpc) { this.joined.clear(); this.live.clear(); this.changed(); }
    });
    this.rpc = rpc; this.shared = shared;
    try {
      await rpc.request('initialize', { clientInfo: { name: 'threadboard', title: 'Threadboard', version: '0.1.0' } }, shared ? 3000 : 15000);
      rpc.send({ method: 'initialized', params: {} });
    } catch (error) { rpc.close(); throw error; }
  }
  private async connect(): Promise<void> {
    if (this.rpc && !this.rpc.closed && (this.shared || Date.now() < this.retrySharedAt)) return;
    this.rpc?.close(); this.joined.clear(); this.live.clear();
    try { await this.start(true); }
    catch { this.retrySharedAt = Date.now() + 30000; await this.start(false); }
  }
  private apply(thread: Thread, status?: Status): void {
    if (!this.shared) return;
    thread.live = !!status && status.type !== 'notLoaded';
    const live = this.live.get(thread.id);
    if (status?.type === 'active') {
      thread.status = 'running'; thread.activeRunId = live?.turnId ?? null;
      const flags = status.activeFlags ?? [];
      if (flags.includes('waitingOnApproval') || live?.approval) thread.pendingRuntimeRequest = { id: live?.approval ?? `${thread.id}:approval`, kind: 'approval' };
      else if (flags.includes('waitingOnUserInput')) thread.pendingRuntimeRequest = { id: `${thread.id}:input`, kind: 'user-input' };
    } else if (status?.type === 'systemError') thread.status = 'failed';
    if (live) {
      thread.latestRunId = live.turnId ?? null;
      if (live.turnId) thread.settlementKey = `${live.turnId}:${live.status}`;
      if (live.status && (live.status !== 'running' || status?.type === 'active')) {
        thread.status = live.status; thread.activeRunId = live.status === 'running' ? live.turnId ?? null : null;
      }
      if (live.completedAt) { thread.updatedAt = live.completedAt; thread.latestRunCompletedAt = live.completedAt; }
      if (live.message) { thread.latestVisibleMessage = live.message; thread.latestAssistantMessage = live.message; }
      if (live.inputId) thread.pendingRuntimeRequest = { id: live.inputId, kind: 'user-input' };
      if (live.pending) {
        thread.pendingRuntimeRequest = { id: live.pending.request.id, kind: 'user-input' };
        thread.questionRequest = live.pending.request;
      }
    }
  }
  async load(): Promise<ShellSnapshot> {
    await this.connect();
    const threads: Thread[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: CodexThread[]; nextCursor: string | null } = await this.rpc!.request('thread/list', { cursor, limit: 100, sortKey: 'updated_at', archived: false, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'] });
      if (!Array.isArray(page.data)) throw new Error('Unsupported Codex thread list.');
      for (const t of page.data) {
        if (typeof t.id !== 'string' || typeof t.cwd !== 'string' || !Number.isFinite(t.createdAt) || !Number.isFinite(t.updatedAt)) throw new Error('Incomplete Codex thread history.');
        if (t.parentThreadId || typeof t.source === 'object' && t.source && 'subagent' in t.source) continue;
        const thread = savedThread(t.id, t.cwd, t.name || t.preview?.replace(/\s+/g, ' ').slice(0, 120) || `Codex ${t.id.slice(0, 8)}`, new Date(t.createdAt * 1000).toISOString(), new Date(t.updatedAt * 1000).toISOString());
        thread.resumeCommand = `CODEX_HOME=${shellQuote(this.home)} ${shellQuote(this.cli)} -C ${shellQuote(t.cwd)} resume ${shellQuote(t.id)}`;
        // Only rejoin sessions already running on this server. Never load a saved session to observe it.
        if (this.shared && ['active', 'idle'].includes(t.status?.type ?? '') && !this.joined.has(t.id)) {
          try {
            await this.rpc!.request('thread/resume', { threadId: t.id, excludeTurns: true });
            this.joined.add(t.id);
            const page = await this.rpc!.request<{ data: Turn[] }>('thread/turns/list', { threadId: t.id, limit: 1, itemsView: 'notLoaded' });
            const turn = page.data[0];
            if (turn) {
              const live = this.live.get(t.id) ?? {};
              // Do not overwrite a newer notification received while hydrating.
              if (!live.turnId) {
                live.turnId = turn.id;
                live.status = turn.status === 'inProgress' ? 'running' : turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed' : 'interrupted';
                if (turn.completedAt) live.completedAt = new Date(turn.completedAt * 1000).toISOString();
                this.live.set(t.id, live);
              }
            }
          } catch { /* Status polling still works when an older server cannot rejoin. */ }
        }
        this.apply(thread, t.status);
        const cached = this.messages.get(t.id);
        if (!thread.latestVisibleMessage && cached?.updatedAt === thread.updatedAt) { thread.latestVisibleMessage = cached.message; thread.latestAssistantMessage = cached.assistant; }
        threads.push(thread);
      }
      cursor = page.nextCursor;
      if (cursor) { if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Invalid Codex history pagination.'); cursors.add(cursor); }
    } while (cursor);
    return { schemaVersion: 2, snapshotSequence: 0, threads, archivedThreads: [], projects: [...new Set(threads.map(t => t.projectId))].map(id => ({ id, title: basename(id) || id })) };
  }
  async readThread(thread: Thread): Promise<void> {
    if (thread.latestVisibleMessage && this.live.get(thread.id)?.message) return;
    if (thread.status !== 'running' && this.messages.get(thread.id)?.updatedAt === thread.updatedAt) return;
    try {
      const page = await this.rpc!.request<{ data: Turn[] }>('thread/turns/list', { threadId: thread.id, limit: 2, sortDirection: 'desc', itemsView: 'full' });
      if (!Array.isArray(page.data)) throw new Error('Unsupported Codex turn history.');
      let message: Thread['latestVisibleMessage'] = null, assistant: Thread['latestAssistantMessage'] = null;
      for (const turn of page.data) {
        for (const item of [...turn.items].reverse()) {
          if (!['agentMessage', 'userMessage'].includes(item.type)) continue;
          const text = item.type === 'agentMessage' ? item.text : item.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
          if (!text?.trim()) continue;
          const value = { id: item.id, role: item.type === 'agentMessage' ? 'assistant' : 'user', text, updatedAt: thread.updatedAt };
          message ??= value;
          if (value.role === 'assistant' && turn === page.data[0]) assistant ??= value;
        }
      }
      thread.latestVisibleMessage = message; thread.latestAssistantMessage = assistant;
      this.messages.set(thread.id, { updatedAt: thread.updatedAt, message, assistant });
    } catch { thread.messageReadError = true; }
  }
  override async dispatch(command: Record<string, unknown>): Promise<void> {
    if (command.type === 'thread.settle') return super.dispatch(command);
    if (!this.shared || !this.rpc || this.rpc.closed) throw new Error('Live controls require the shared Codex server.');
    const threadId = String(command.threadId);
    if (command.type === 'thread.stop') {
      const current = await this.rpc.request<{ thread: CodexThread }>('thread/read', { threadId });
      if (current.thread.status?.type !== 'active') throw new Error('This Codex thread is no longer working.');
      const turns = await this.rpc.request<{ data: Turn[] }>('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
      const turn = turns.data.find(t => t.status === 'inProgress');
      if (!turn) throw new Error('Codex has no active turn to stop.');
      await this.rpc.request('turn/interrupt', { threadId, turnId: turn.id });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const latest = await this.rpc.request<{ data: Turn[] }>('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
        if (!latest.data.some(t => t.id === turn.id && t.status === 'inProgress')) return;
        await delay(100);
      }
      throw new Error('Codex has not confirmed the interrupted turn. Check the provider before retrying.');
    }
    if (command.type === 'runtime-request.respond') {
      const pending = this.live.get(threadId)?.pending;
      if (!pending || pending.request.id !== command.requestId || JSON.stringify(pending.request) !== command.questionSignature) throw new Error('This Codex question changed before submission.');
      const answers = command.answers as Record<string, string | string[]>;
      for (const q of pending.request.questions) {
        const values = Array.isArray(answers[q.id]) ? answers[q.id] as string[] : [answers[q.id]];
        if (!values.length || values.some(v => typeof v !== 'string' || !q.options.some(o => o.label === v))) throw new Error('Invalid Codex answer.');
      }
      this.rpc.send({ id: pending.nativeId, result: { answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: Array.isArray(value) ? value : [value] }])) } });
      const deadline = Date.now() + 5000;
      while (this.live.get(threadId)?.pending === pending && !this.rpc.closed && Date.now() < deadline) await delay(30);
      if (this.live.get(threadId)?.pending === pending || this.rpc.closed) throw new Error('Codex did not confirm the answer. Check the provider before retrying.');
      return;
    }
    throw new Error('Unsupported Codex command.');
  }
  override async close(): Promise<void> {
    if (this.notify) clearTimeout(this.notify); this.notify = null;
    const rpc = this.rpc; this.rpc = null; rpc?.close(); this.joined.clear(); this.live.clear();
  }
}
