import type { Thread } from './types.ts';
export function projectionMessages(projection: unknown, latestRunId: string | null): Pick<Thread, 'latestVisibleMessage' | 'latestAssistantMessage'>;
export function createMessageReader(readProjection: (threadId: string) => Promise<unknown>): (threads: Thread[]) => Promise<void>;
