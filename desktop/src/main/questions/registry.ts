import type { QuestionResults } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';
import { bestFlaskQuestion } from './best-flask';
import { bestFoodQuestion } from './best-food';
import type { Question } from './index';

/**
 * The set of questions Simly currently runs each sim cycle.
 *
 * Phase 4 will expand this with potion, phial, weapon-enchant, and gem
 * questions. Order doesn't affect SimC behavior but affects the order of
 * `profileset.` lines in the input — keep it stable for log readability.
 */
export const QUESTIONS: readonly Question<unknown>[] = [
  bestFlaskQuestion as Question<unknown>,
  bestFoodQuestion as Question<unknown>,
];

export function buildAllQuestionLines(): string {
  return QUESTIONS.map((q) => q.buildLines()).join('\n\n');
}

export function parseAllQuestions(run: SimcRunResult): QuestionResults {
  const out: QuestionResults = {};
  for (const q of QUESTIONS) {
    const result = q.parseResult(run);
    if (result !== undefined) {
      (out as Record<string, unknown>)[q.id] = result;
    }
  }
  return out;
}
