/**
 * Question definition for the desktop's question suite. Each question owns
 * how to mutate a SimC profile to enumerate candidates and how to parse the
 * resulting SimC output. See SCOPE.md sections 3 and 6 (phase 4).
 */

export interface QuestionDefinition<TResult = unknown> {
  id: string;
  label: string;
  mutateProfile: (profile: string) => string;
  parseResult: (simcOutput: string) => TResult;
}
