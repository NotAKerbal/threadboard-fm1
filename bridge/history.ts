import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ShellSnapshot, Thread, ThreadSource } from './types.ts';

export const historyCapabilities = { stop: false, answer: false };
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function savedThread(id: string, cwd: string, title: string, createdAt: string, updatedAt: string): Thread {
  return {
    id, projectId: cwd, title, createdAt, updatedAt, status: 'saved', activeRunId: null,
    latestRunId: null, latestVisibleMessage: null, pendingRuntimeRequest: null,
    hasActionableProposedPlan: false, lineage: { relationshipToParent: null },
    settledOverride: null, archivedAt: null, deletedAt: null,
  };
}

/** History controls affect Threadboard only, never the provider's saved conversations. */
export abstract class HistorySource implements ThreadSource {
  readonly environmentId: string;
  get capabilities() { return historyCapabilities; }
  private statePath: string;
  private state: Record<string, { settledAt?: string; visitedAt?: string; settledVersion?: string }> | null = null;
  private threads = new Map<string, Thread>();
  constructor(provider: string, home: string, stateDir: string) {
    this.environmentId = `${provider}-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`;
    this.statePath = join(stateDir, `history-${this.environmentId}.json`);
  }
  abstract load(): Promise<ShellSnapshot>;
  async snapshot(): Promise<ShellSnapshot> {
    if (!this.state) {
      try {
        const state: unknown = JSON.parse(await readFile(this.statePath, 'utf8'));
        if (!state || typeof state !== 'object' || Array.isArray(state) || Object.values(state).some(v => !v || typeof v !== 'object' || Object.entries(v).some(([k, t]) => typeof t !== 'string' || k !== 'settledVersion' && !Number.isFinite(Date.parse(t))))) throw new Error('Invalid saved history state.');
        this.state = state as NonNullable<typeof this.state>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.state = {};
      }
    }
    const snapshot = await this.load();
    snapshot.completeHistory = true;
    for (const thread of snapshot.threads) {
      const state = this.state[thread.id];
      thread.lastVisitedAt = state?.visitedAt ?? null;
      const settled = thread.settlementKey ? state?.settledVersion === thread.settlementKey : state?.settledAt === thread.updatedAt;
      if (settled && !thread.activeRunId && !thread.pendingRuntimeRequest && !['running', 'waiting'].includes(thread.status)) thread.settledOverride = 'settled';
    }
    this.threads = new Map(snapshot.threads.map(t => [t.id, t]));
    return snapshot;
  }
  private async save(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.state) + '\n', { mode: 0o600 });
    await rename(temp, this.statePath);
  }
  async openThread(id: string): Promise<void> {
    if (!this.threads.has(id) || !this.state) throw new Error('This saved thread is unavailable.');
    this.state[id] = { ...this.state[id], visitedAt: new Date().toISOString() };
    await this.save();
  }
  async dispatch(command: Record<string, unknown>): Promise<void> {
    if (command.type !== 'thread.settle') throw new Error('Use the provider to stop work or answer requests. Threadboard displays saved history.');
    const thread = this.threads.get(String(command.threadId));
    if (!thread || !this.state) throw new Error('This saved thread is unavailable.');
    this.state[thread.id] = { ...this.state[thread.id], settledAt: thread.updatedAt, ...(thread.settlementKey ? { settledVersion: thread.settlementKey } : {}) };
    await this.save();
  }
  async close(): Promise<void> {}
}
