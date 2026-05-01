import {
  RESULTS_SCHEMA_VERSION,
  type SimlyResults,
} from '@simly/shared';

/**
 * Hardcoded results blob used by the phase 1 spike. Phase 2 replaces this
 * with output parsed from a real SimulationCraft run.
 */
export function buildPlaceholderResults(characterKey: string): SimlyResults {
  return {
    schema_version: RESULTS_SCHEMA_VERSION,
    generated_at: Math.floor(Date.now() / 1000),
    simc_version: 'placeholder',
    character_key: characterKey,
    questions: {
      best_flask: {
        label: 'Best flask',
        best: {
          item_id: 212265,
          name: 'Phial of Tepid Versatility',
          dps: 1234567,
        },
        alternatives: [
          {
            item_id: 212266,
            name: 'Phial of Elemental Chaos',
            dps: 1230000,
            delta_pct: -0.37,
          },
        ],
      },
    },
  };
}
