import type { QuestionRequest } from './types.ts';
export function questionRequest(projection: unknown, id: string): QuestionRequest | null;
export function validAnswers(request: QuestionRequest | null, answers: unknown): boolean;
