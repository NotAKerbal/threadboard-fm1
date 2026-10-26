import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, copyFileSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { KEY_COUNT, THREAD_KEYS, ANSWER_KEYS, isActive, lightState } from './types.ts';
import type { SavedBindings, ShellSnapshot, Slot, Thread } from './types.ts';

export class Bindings {
  readonly path: string | null;
  saved: SavedBindings;
  constructor(path: string | null, environmentId: string) {
    this.path = path;
    this.saved = { version: 1, environmentId, slots: Array.from({ length: KEY_COUNT }, () => null), selected: 0, layout: 'white-threads', waiting: [] };
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as SavedBindings;
      const ids = new Set<string>();
      if (raw.version !== 1 || raw.environmentId !== environmentId || !Array.isArray(raw.slots) || raw.slots.length !== KEY_COUNT || !Number.isInteger(raw.selected) || raw.selected < 0 || raw.selected >= KEY_COUNT) throw new Error('Invalid thread assignment file');
      if (raw.waiting !== undefined && !Array.isArray(raw.waiting)) throw new Error('Invalid waiting thread assignments');
      for (const slot of [...raw.slots, ...raw.waiting ?? []]) {
        if (slot !== null) {
          if (!slot || typeof slot.threadId !== 'string' || !slot.threadId || !Number.isInteger(slot.token) || slot.token < 1 || slot.token > 0xffffffff || ids.has(slot.threadId)) throw new Error('Invalid or duplicate thread assignment');
          ids.add(slot.threadId);
        }
      }
      this.saved = raw;
      if (raw.nextAttention !== undefined && (!Number.isInteger(raw.nextAttention) || raw.nextAttention < 0 || raw.nextAttention > 0xffffffff)) throw new Error('Invalid saved notification sequence');
      if (raw.attention && (typeof raw.attention !== 'object' || Object.values(raw.attention).some(v => !v || typeof v.cause !== 'string' || !Number.isInteger(v.serial) || v.serial < 1 || v.serial > 0xffffffff))) throw new Error('Invalid saved notification state');
      if (raw.layout !== undefined && raw.layout !== 'white-threads') throw new Error('Unsupported key layout');
      if (raw.layout === 'white-threads' && ANSWER_KEYS.some(key => raw.slots[key])) throw new Error('A reserved answer key contains a thread');
      if (!raw.layout) {
        // Keep existing white positions; move only bindings on newly reserved keys.
        try { copyFileSync(path, `${path}.before-white-keys`, constants.COPYFILE_EXCL); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        const selectedId = raw.slots[raw.selected]?.threadId;
        raw.waiting = [...raw.waiting ?? [], ...ANSWER_KEYS.flatMap(key => raw.slots[key] ? [raw.slots[key]!] : [])];
        for (const key of ANSWER_KEYS) raw.slots[key] = null;
        for (const key of THREAD_KEYS) if (!raw.slots[key] && raw.waiting.length) raw.slots[key] = raw.waiting.shift()!;
        const selected = raw.slots.findIndex(b => b?.threadId === selectedId);
        raw.selected = selected >= 0 && THREAD_KEYS.some(key => key === selected) ? selected : THREAD_KEYS[0];
        raw.layout = 'white-threads'; this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.saved) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
  }
  reconcile(snapshot: ShellSnapshot): { slots: Slot[]; overflow: number } {
    const all = new Map([...snapshot.threads, ...snapshot.archivedThreads].map(t => [t.id, t]));
    let changed = false;
    this.saved.slots = this.saved.slots.map(binding => {
      const t = binding && all.get(binding.threadId);
      // Absence can mean a partial server response. Only explicit state releases a key.
      if (binding && t && !t.unavailable && !isActive(t)) { changed = true; return null; }
      return binding;
    });
    this.saved.waiting = (this.saved.waiting ?? []).filter(binding => {
      const t = all.get(binding.threadId);
      if (t && !t.unavailable && !isActive(t)) { changed = true; return false; }
      return true;
    });
    const assigned = new Set([...this.saved.slots.flatMap(b => b ? [b.threadId] : []), ...this.saved.waiting.map(b => b.threadId)]);
    const rank = (t: Thread): number => ({ attention: 0, working: 1, idle: 2, empty: 3, unavailable: 4 })[lightState(t).state];
    const candidates = snapshot.threads.filter(t => isActive(t) && !assigned.has(t.id))
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    for (const key of THREAD_KEYS) {
      if (this.saved.slots[key]) continue;
      if (this.saved.waiting.length) { this.saved.slots[key] = this.saved.waiting.shift()!; changed = true; continue; }
      if (!candidates.length) break;
      const t = candidates.shift()!;
      this.saved.slots[key] = { threadId: t.id, token: randomBytes(4).readUInt32LE() || 1 };
      changed = true;
    }
    if (changed) this.save();
    const projects = new Map(snapshot.projects.map(p => [p.id, p.title]));
    const attention = this.saved.attention ??= {};
    let notificationChanged = false;
    const slots = this.saved.slots.map((b, key): Slot => {
      if (!b) return { key, token: 0, threadId: null, title: ANSWER_KEYS.some(k => k === key) ? 'Reserved for question choices' : 'Unassigned', project: '', detail: ANSWER_KEYS.some(k => k === key) ? 'Black keys are reserved for answering questions' : 'This white key is available', state: 'empty', status: 'empty' };
      const t = all.get(b.threadId);
      if (!t) return { key, token: b.token, threadId: b.threadId, title: 'Thread unavailable', project: '', detail: 'Assignment kept until T3 confirms settlement', state: 'unavailable', status: 'unavailable' };
      const { state, reason } = lightState(t);
      if (state === 'attention') {
        const cause = t.pendingRuntimeRequest ? `request:${t.pendingRuntimeRequest.id}`
          : t.pendingGuestMessageCount ? `guests:${t.pendingGuestMessageCount}`
          : t.status === 'completed' ? `done:${t.latestRunId ?? t.latestRunCompletedAt ?? t.latestVisibleMessage?.id ?? t.createdAt}`
          : t.status === 'failed' ? `failure:${t.latestRunId}`
          : `message:${t.latestVisibleMessage?.id ?? 'plan'}:${t.latestVisibleMessage?.updatedAt ?? t.updatedAt}`;
        if (attention[t.id]?.cause !== cause) {
          const serial = ((this.saved.nextAttention ?? 0) + 1) >>> 0 || 1;
          this.saved.nextAttention = serial; attention[t.id] = { cause, serial }; notificationChanged = true;
        }
      }
      const text = t.latestVisibleMessage?.text.replace(/\s+/g, ' ').trim() ?? '';
      const project = projects.get(t.projectId) ?? 'Project';
      return { key, token: b.token, threadId: t.id, title: t.title, project: t.machine ? `${t.machine} / ${project}` : project, detail: `${reason}${text ? ': ' + text : ''}`, state, status: t.status, attentionSerial: attention[t.id]?.serial ?? 0, machine: t.machine };
    });
    if (notificationChanged) this.save();
    return { slots, overflow: candidates.length + this.saved.waiting.length };
  }
  select(key: number): void { this.saved.selected = key; this.save(); }
}
