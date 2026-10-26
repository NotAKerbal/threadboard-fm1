import type { ShellSnapshot, Thread, QuestionRequest } from './types.ts';
export function demoQuestion(id:string):QuestionRequest{return {id,responseCapability:'live',questions:[{id:'direction',header:'Next step',question:'Which part should I work on next?',options:[{label:'Keyboard controls',description:'Finish the physical controls.'},{label:'Thread display',description:'Refine the screen layout.'}]},{id:'checks',header:'Checks',question:'Which checks should I run? Choose all that apply.',multiSelect:true,options:['Browser','MIDI','Firmware','Remote reconnect','Persistence','Mobile','Chime','Overflow','Questions','Stale requests','Offline machines','Full flow'].map(label=>({label,description:`Verify ${label.toLowerCase()}.`}))}]};}
export function demoSnapshot(): ShellSnapshot {
  const now = new Date().toISOString();
  const thread = (id: string, title: string, projectId: string, status: string): Thread => ({
    id, title, projectId, status, activeRunId: status === 'running' ? `run-${id}` : null, latestRunId: `run-${id}`,
    latestVisibleMessage: null, pendingRuntimeRequest: null, hasActionableProposedPlan: false,
    lineage: { relationshipToParent: null }, settledOverride: 'active', archivedAt: null, deletedAt: null,
    updatedAt: now, createdAt: now, lastVisitedAt: null,
  });
  const threads = [thread('reader','Improve reader controls','verse','running'), thread('auth','Check sign-in persistence','verse','waiting'), thread('storage','Review backup storage','lab','completed'), thread('bridge','Build agent console','tools','running'), thread('journal','Simplify journal notes','verse','idle')];
  threads[0]!.latestVisibleMessage = { id: 'progress-1', role: 'assistant', text: 'Checking the reader controls. I am verifying that the saved reading position is restored when you reopen a book.', updatedAt: now };
  threads[1]!.pendingRuntimeRequest = { id: 'question-1', kind: 'user-input', blocking: true };
  threads[1]!.questionRequest=demoQuestion('question-1');
  threads[2]!.latestVisibleMessage = { id: 'm-1', role: 'assistant', text: 'The backup finished successfully. Ready for you to review the retention settings.', updatedAt: now };
  return { schemaVersion: 2, snapshotSequence: 1, threads, archivedThreads: [], projects: [{ id: 'verse', title: 'Reading app' }, { id: 'lab', title: 'Homelab' }, { id: 'tools', title: 'Tools' }] };
}
