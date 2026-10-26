import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Bindings } from './bindings.ts';
import { demoSnapshot,demoQuestion } from './demo.ts';
import { Questions } from './questions.ts';
import { resultExcerpt } from './result.ts';
import { KEY_COUNT, WORKING, THREAD_KEYS } from './types.ts';
import type { BoardAction, BoardView, ShellSnapshot, ThreadSource } from './types.ts';

export class Board extends EventEmitter {
  readonly client: ThreadSource | null;
  readonly stateDir: string;
  readonly demo: boolean;
  view: BoardView;
  snapshot: ShellSnapshot | null = null;
  private bindings: Bindings | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing = false;
  private questions = new Questions();
  constructor(client: ThreadSource | null, stateDir: string, demo = false) {
    super();
    this.client = client; this.stateDir = stateDir; this.demo = demo;
    this.view = { environmentId: demo ? 'demo' : '', connected: false, error: null, selected: 0, overflow: 0, revision: 0, slots: [], midi: { connected: false, name: null, error: null } };
    if (demo) this.snapshot = demoSnapshot();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => undefined); return result;
  }
  private publish(): void {
    this.view.revision = (this.view.revision + 1) >>> 0;
    this.emit('change', this.view);
  }
  private async refreshNow(): Promise<void> {
    try {
      const snapshot = this.demo ? this.snapshot! : await this.client!.snapshot();
      const environmentId = this.demo ? 'demo' : this.client!.environmentId;
      if (this.bindings?.saved.environmentId !== environmentId) this.bindings = new Bindings(this.demo ? null : join(this.stateDir, `bindings-${environmentId}.json`), environmentId);
      const { slots, overflow } = this.bindings.reconcile(snapshot);
      const selected=slots[this.bindings.saved.selected];
      const thread=snapshot.threads.find(t=>t.id===selected?.threadId);
      const question=this.questions.view(thread,slots);
      const result=thread&&thread.status==='completed'&&selected?.state==='attention'&&!question&&!thread.pendingRuntimeRequest ? {threadId:thread.id,text:resultExcerpt(thread)} : null;
      this.snapshot = snapshot;
      const connected = !snapshot.environments || snapshot.environments.some(e => e.connected);
      Object.assign(this.view, { environmentId, connected, error: connected ? null : 'All T3 machines are disconnected. Assignments are preserved.', selected: this.bindings.saved.selected, slots, overflow, environments: snapshot.environments,question,result });
    } catch (e) {
      this.view.connected = false;
      this.view.error = e instanceof Error ? e.message : 'Could not read T3 threads';
    }
    this.publish();
  }
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try { await this.serial(() => this.refreshNow()); } finally { this.refreshing = false; }
  }
  setMidi(midi: BoardView['midi']): void { this.view.midi = midi; this.publish(); }
  async act(input: BoardAction): Promise<void> {
    return this.serial(async () => {
      await this.refreshNow();
      if (!this.view.connected || !this.bindings || !this.snapshot) throw new Error('T3 is disconnected. Assignments are preserved.');
      const { key, token } = input;
      if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT || !Number.isInteger(token)) throw new Error('Invalid key');
      if(['choose','confirm','question','page'].includes(input.action)){
        const response=this.questions.act(input,this.view.slots[this.view.selected]!);
        if(response){
          if(this.demo){const t=this.snapshot.threads.find(t=>t.id===response.threadId)!;t.pendingRuntimeRequest=null;t.questionRequest=null;t.status='running';t.activeRunId='demo-answer-run';}
          else await this.client!.dispatch({type:'runtime-request.respond',...response});
        }
        await this.refreshNow();return;
      }
      let slot = this.view.slots[key];
      if (!slot || slot.token !== token) throw new Error('This key assignment changed. Try again after it refreshes.');
      if (input.action === 'next') {
        const keys = Array.from({ length: KEY_COUNT }, (_, i) => (this.view.selected + 1 + i) % KEY_COUNT);
        const next = keys.find(k => THREAD_KEYS.some(t=>t===k)&&this.view.slots[k]?.state === 'attention');
        if (next === undefined) throw new Error('No threads need your attention.');
        slot = this.view.slots[next]!;
      }
      if (!slot.threadId || slot.state === 'unavailable') throw new Error('This key has no available thread.');
      const thread = this.snapshot.threads.find(t => t.id === slot!.threadId);
      if (!thread) throw new Error('Thread is unavailable');
      switch (input.action) {
        case 'select':
        case 'next':
          this.bindings.select(slot.key);
          if (this.demo) thread.lastVisitedAt = new Date().toISOString();
          else await this.client!.openThread(thread.id);
          break;
        case 'stop':
          if (!WORKING.has(thread.status) && !thread.activeRunId && !thread.pendingBackgroundTasks?.length) throw new Error('This thread is not working.');
          if (this.demo) { thread.status = 'interrupted'; thread.activeRunId = null; }
          else await this.client!.dispatch({ type: 'thread.stop', threadId: thread.id, reason: 'Stopped from the FM-1' });
          break;
        case 'settle':
          if (WORKING.has(thread.status) || thread.activeRunId || thread.pendingBackgroundTasks?.length || thread.pendingRuntimeRequest) throw new Error('Finish or stop this thread and answer its pending requests before settling it.');
          if (this.demo) thread.settledOverride = 'settled';
          else await this.client!.dispatch({ type: 'thread.settle', threadId: thread.id });
          break;
        case 'scroll': break;
        default: throw new Error('Unknown action');
      }
      await this.refreshNow();
      if (!this.view.connected) throw new Error('The command was sent, but T3 did not confirm its resulting state.');
      if (input.action === 'settle' && this.view.slots[key]?.threadId === thread.id) throw new Error('T3 has not confirmed settlement yet. The key stays assigned.');
    });
  }
  async demoState(key: number, state: string): Promise<void> {
    if (!this.demo) throw new Error('Demo controls are disabled');
    await this.serial(async () => {
      const id = this.view.slots[key]?.threadId;
      const thread = this.snapshot?.threads.find(t => t.id === id);
      if (!thread) throw new Error('Select an assigned key first');
      const now = new Date().toISOString();
      thread.pendingRuntimeRequest = null; thread.latestVisibleMessage = null; thread.activeRunId = null; thread.updatedAt = now;
      if (state === 'working') { thread.status = 'running'; thread.activeRunId = `run-${Date.now()}`; }
      else if (state === 'attention') { const id=`q-${Date.now()}`;thread.status = 'waiting'; thread.activeRunId = 'waiting-run'; thread.pendingRuntimeRequest = { id, kind: 'user-input' };thread.questionRequest=demoQuestion(id); }
      else if (state === 'finished') { thread.status = 'completed'; thread.latestVisibleMessage = { id: `m-${Date.now()}`, role: 'assistant', text: 'The work is ready for you to review. This thread keeps its key until you settle it.', updatedAt: now }; }
      else throw new Error('Unknown demo state');
      await this.refreshNow();
    });
  }
}
