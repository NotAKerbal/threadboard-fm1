export const KEY_COUNT = 27;
export const THREAD_KEYS = [0,2,4,6,7,9,11,12,14,16,18,19,21,23,24,26] as const;
export const ANSWER_KEYS = [1,3,5,8,10,13,15,17,20,22,25] as const;
export interface Question { id: string; header: string; question: string; options: {label:string;description:string;value?:string}[]; multiSelect?:boolean; required?:boolean }
export interface QuestionRequest { id:string; questions:Question[]; responseCapability:'live'|'message'|'not_resumable' }
export interface QuestionView { token:number; threadId:string; requestId:string; header:string; text:string; index:number; total:number; page:number; pages:number; answered:number; multiSelect:boolean; canSubmit:boolean; submitted:boolean; choices:{key:number;label:string;description:string;selected:boolean}[] }
export type LightState = 'empty' | 'idle' | 'working' | 'attention' | 'unavailable';
export interface Thread {
  id: string;
  projectId: string;
  title: string;
  status: string;
  activeRunId: string | null;
  latestRunId: string | null;
  latestRunCompletedAt?: string | null;
  latestVisibleMessage: { id: string; role: string; text: string; updatedAt: string } | null;
  latestUserAuthoredMessageAt?: string | null;
  lastVisitedAt?: string | null;
  pendingRuntimeRequest: { id: string; kind: string; blocking?: boolean } | null;
  hasActionableProposedPlan: boolean;
  pendingGuestMessageCount?: number;
  pendingBackgroundTasks?: unknown[];
  activityRunStatus?: string | null;
  blockedOnThreadWait?: boolean;
  lineage: { relationshipToParent: string | null; parentThreadId?: string | null };
  settledOverride: 'settled' | 'active' | null;
  archivedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  createdAt: string;
  snoozedUntil?: string | null;
  environmentId?: string;
  machine?: string;
  unavailable?: boolean;
  questionRequest?: QuestionRequest | null;
}
export interface ShellSnapshot {
  schemaVersion: number;
  snapshotSequence: number;
  threads: Thread[];
  archivedThreads: Thread[];
  projects: { id: string; title: string }[];
  environments?: EnvironmentStatus[];
  question?: QuestionView | null;
}
export interface EnvironmentStatus { id: string; label: string; connected: boolean; error: string | null }
export interface ThreadSource {
  environmentId: string;
  snapshot(): Promise<ShellSnapshot>;
  dispatch(command: Record<string, unknown>): Promise<void>;
  openThread(id: string): Promise<void>;
}
export interface Binding { threadId: string; token: number }
export interface SavedBindings {
  version: 1; environmentId: string; slots: (Binding | null)[]; selected: number;
  attention?: Record<string, { cause: string; serial: number }>;
  nextAttention?: number;
  layout?: 'white-threads';
  waiting?: Binding[];
}
export interface Slot {
  key: number;
  token: number;
  threadId: string | null;
  title: string;
  project: string;
  detail: string;
  state: LightState;
  status: string;
  attentionSerial?: number;
  machine?: string;
}
export interface BoardView {
  question?: QuestionView | null;
  environmentId: string;
  connected: boolean;
  error: string | null;
  slots: Slot[];
  selected: number;
  overflow: number;
  revision: number;
  midi: { connected: boolean; name: string | null; error: string | null };
  environments?: EnvironmentStatus[];
}
export type ActionName = 'select' | 'next' | 'stop' | 'settle' | 'scroll' | 'choose' | 'confirm' | 'question' | 'page';
export interface BoardAction { action: ActionName; key: number; token: number; value?: number }
export const WORKING = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
export function isActive(t: Thread): boolean {
  return t.settledOverride !== 'settled' && !t.archivedAt && !t.deletedAt && t.lineage.relationshipToParent !== 'subagent';
}
export function lightState(t: Thread, now = Date.now()): { state: LightState; reason: string } {
  if (t.unavailable) return { state: 'unavailable', reason: `${t.machine ?? 'Machine'} is disconnected` };
  if (!isActive(t)) return { state: 'idle', reason: 'Settled' };
  if (t.snoozedUntil && Date.parse(t.snoozedUntil) > now) return { state: 'idle', reason: 'Snoozed' };
  if (t.pendingRuntimeRequest) {
    return { state: 'attention', reason: /approv|permission/.test(t.pendingRuntimeRequest.kind) ? 'Approval waiting' : 'Question waiting' };
  }
  if (t.pendingGuestMessageCount) return { state: 'attention', reason: 'Guest message waiting' };
  if (WORKING.has(t.status) || (t.activityRunStatus && WORKING.has(t.activityRunStatus)) || t.pendingBackgroundTasks?.length) {
    return { state: 'working', reason: t.blockedOnThreadWait ? 'Waiting for agents' : 'Working' };
  }
  if (t.hasActionableProposedPlan) return { state: 'attention', reason: 'Plan ready for review' };
  if (t.status === 'completed') return { state: 'attention', reason: 'Done, awaiting settlement' };
  const visited = Date.parse(t.lastVisitedAt ?? '') || 0;
  if (t.status === 'failed' && (Date.parse(t.latestRunCompletedAt ?? t.updatedAt) || 0) > visited) {
    return { state: 'attention', reason: 'Run failed' };
  }
  const message = t.latestVisibleMessage;
  if (message?.role === 'assistant' && Date.parse(message.updatedAt) > Math.max(visited, Date.parse(t.latestUserAuthoredMessageAt ?? '') || 0)) {
    return { state: 'attention', reason: 'Response ready to read' };
  }
  return { state: 'idle', reason: 'Ready' };
}
