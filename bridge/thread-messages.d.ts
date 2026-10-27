import type { Thread, QuestionRequest, Question } from './types.ts';
export function projectionMessages(projection: unknown, latestRunId: string | null): Pick<Thread, 'latestVisibleMessage' | 'latestAssistantMessage'>;
export function createMessageReader(readProjection: (threadId: string) => Promise<unknown>): (threads: Thread[]) => Promise<void>;

export function approvalQuestion(id: string, revision: string, text: string, options: Question["options"]): QuestionRequest | null;
