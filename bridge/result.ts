import type { Thread } from './types.ts';

// Use the agent's own result, without generating a second interpretation.
export function resultExcerpt(thread: Thread): string {
  const message = thread.latestVisibleMessage;
  if (!message || message.role !== 'assistant' || !message.text.trim()) return 'No final response is available. Press PLAY to open this thread in T3.';
  const plain = message.text
    .replace(/```[^\n]*\n/g, '').replace(/```/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s?)/gm, '')
    .replace(/\*{1,2}([^\n*]+)\*{1,2}/g, '$1')
    .replace(/(?<!\w)_{1,2}([^\n_]+)_{1,2}(?!\w)/g, '$1')
    .replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= 1200) return plain;
  const prefix = plain.slice(0, 1150);
  return prefix.slice(0, prefix.lastIndexOf(' ') > 1100 ? prefix.lastIndexOf(' ') : prefix.length) + ' ... Open in T3 for the full result.';
}
