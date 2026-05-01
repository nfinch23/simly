/**
 * Results file schema written by the desktop app and read by the addon.
 * Mirrors SCOPE.md section 5. One file, one character.
 */

export const RESULTS_SCHEMA_VERSION = 1;

/**
 * Common shape for "best consumable" questions. Each candidate is an
 * item with a name + item_id (for tooltip lookup) + DPS measurement.
 * The winner sits in `best`; everything else lands in `alternatives`
 * with a delta_pct vs the winner.
 */
export interface BestConsumableResult {
  label: string;
  best: { item_id: number; name: string; dps: number };
  alternatives: Array<{
    item_id: number;
    name: string;
    dps: number;
    delta_pct: number;
  }>;
}

export type BestFlaskResult = BestConsumableResult;
export type BestFoodResult = BestConsumableResult;

export interface BestGemsResult {
  label: string;
  slots: Array<{
    slot: string;
    item_id: number;
    gem_id: number;
    gem_name: string;
  }>;
}

export interface QuestionResults {
  best_flask?: BestFlaskResult;
  best_food?: BestFoodResult;
  best_gems?: BestGemsResult;
  [questionId: string]: unknown;
}

export interface SimlyResults {
  schema_version: number;
  generated_at: number;
  simc_version: string;
  character_key: string;
  questions: QuestionResults;
}
