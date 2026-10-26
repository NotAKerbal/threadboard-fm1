import { randomUUID } from 'node:crypto';
import { T3Client } from './t3.ts';
import type { ShellSnapshot, ThreadSource } from './types.ts';

export interface DesktopEnvironment { id: string; label: string; connected: boolean; snapshot: ShellSnapshot | null }
export interface DesktopCommand { id: string; environmentId: string; input: Record<string, unknown>; expectedQuestion?:string }

/** The desktop owns remote authentication. The bridge sends only thread controls and question answers. */
export class DesktopSource implements ThreadSource {
  readonly environmentId: string;
  readonly local: T3Client;
  readonly token = randomUUID();
  private receivedAt = 0;
  private cached: DesktopEnvironment[] = [];
  private pending = new Map<string, { command: DesktopCommand; sent: boolean; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(local: T3Client, environmentId: string) { this.local = local; this.environmentId = environmentId; }
  receive(environments: DesktopEnvironment[]): void {
    if (!Array.isArray(environments) || environments.length > 100 || new Set(environments.map(e => e.id)).size !== environments.length) throw new Error('Invalid desktop machine list.');
    for (const e of environments) {
      if (!e || typeof e.id !== 'string' || !/^[\w-]+$/.test(e.id) || typeof e.label !== 'string' || typeof e.connected !== 'boolean') throw new Error('Invalid desktop machine.');
      if (e.snapshot && (e.snapshot.schemaVersion !== 2 || !Array.isArray(e.snapshot.threads) || !Array.isArray(e.snapshot.archivedThreads) || !Array.isArray(e.snapshot.projects))) throw new Error('Unsupported desktop thread state.');
      for (const t of [...e.snapshot?.threads ?? [], ...e.snapshot?.archivedThreads ?? []]) if (!t || typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.updatedAt !== 'string' || !Number.isFinite(Date.parse(t.updatedAt)) || !t.lineage || !('settledOverride' in t) || !('pendingRuntimeRequest' in t)) throw new Error('Incomplete desktop thread state.');
    }
    this.cached = structuredClone(environments); this.receivedAt = Date.now();
  }
  commands(): DesktopCommand[] {
    const commands: DesktopCommand[] = [];
    // Each command is delivered once. A lost result must never repeat a mutation.
    for (const p of this.pending.values()) if (!p.sent) { p.sent = true; commands.push(p.command); }
    return commands;
  }
  result(id: string, ok: boolean): void {
    const p = this.pending.get(id); if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer);
    if (ok) p.resolve(); else p.reject(new Error('T3 did not apply the desktop command.'));
  }
  async snapshot(): Promise<ShellSnapshot> {
    if (!this.receivedAt) return this.local.snapshot();
    const fresh = Date.now() - this.receivedAt < 6000;
    const merged: ShellSnapshot = { schemaVersion: 2, snapshotSequence: 0, threads: [], archivedThreads: [], projects: [], environments: [] };
    for (const e of this.cached) {
      const connected = fresh && e.connected;
      merged.environments!.push({ id: e.id, label: e.label, connected, error: connected ? null : fresh ? 'Disconnected in T3' : 'Desktop adapter disconnected' });
      if (!e.snapshot) continue;
      const scoped = (id: string): string => e.id === this.environmentId ? id : `${e.id}::${id}`;
      for (const field of ['threads', 'archivedThreads'] as const) for (const t of e.snapshot[field]) merged[field].push({ ...t, id: scoped(t.id), projectId: scoped(t.projectId), environmentId: e.id, machine: e.label, unavailable: !connected });
      merged.projects.push(...e.snapshot.projects.map(p => ({ ...p, id: scoped(p.id) })));
      merged.snapshotSequence = Math.max(merged.snapshotSequence, e.snapshot.snapshotSequence);
    }
    return merged;
  }
  private route(id: string): { environmentId: string; nativeId: string } {
    const split = id.indexOf('::');
    const environmentId = split < 0 ? this.environmentId : id.slice(0, split), nativeId = split < 0 ? id : id.slice(split + 2);
    if (Date.now() - this.receivedAt >= 6000 || !this.cached.some(e => e.id === environmentId && e.connected && e.snapshot?.threads.some(t => t.id === nativeId))) throw new Error('This thread is disconnected in the T3 desktop.');
    return { environmentId, nativeId };
  }
  async dispatch(input: Record<string, unknown>): Promise<void> {
    if (!this.receivedAt) return this.local.dispatch(input);
    if (!['thread.stop', 'thread.settle','runtime-request.respond'].includes(String(input.type))) throw new Error('Unsupported desktop command.');
    const route = this.route(String(input.threadId)), id = randomUUID();
    const {questionSignature,...commandInput}=input;
    if(input.type==='runtime-request.respond'){
      const thread=this.cached.find(e=>e.id===route.environmentId)?.snapshot?.threads.find(t=>t.id===route.nativeId);
      if(!thread?.questionRequest||thread.pendingRuntimeRequest?.id!==input.requestId||thread.questionRequest.id!==input.requestId||questionSignature!==JSON.stringify(thread.questionRequest))throw new Error('This question changed before submission.');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Desktop command was not confirmed. Refresh before retrying.')); }, 10000);
      this.pending.set(id, { command: { id, environmentId: route.environmentId, input: { ...commandInput, threadId: route.nativeId, commandId: id },...(typeof questionSignature==='string'?{expectedQuestion:questionSignature}:{}) }, sent: false, resolve, reject, timer });
    });
  }
  async openThread(id: string): Promise<void> {
    if (!this.receivedAt) return this.local.openThread(id);
    const route = this.route(id);
    const opener = new T3Client(); opener.environmentId = route.environmentId;
    await opener.openThread(route.nativeId);
  }
  async close(): Promise<void> {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Threadboard closed.')); }
    this.pending.clear(); await this.local.close();
  }
}
