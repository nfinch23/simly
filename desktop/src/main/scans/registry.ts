import type { ScanCollection, ScanRecord } from '@simly/shared';
import type { SimcRunResult } from '../simc-runner';
import { bestFlaskScan } from './best-flask';
import { bestFoodScan } from './best-food';
import { bestPotionScan } from './best-potion';
import type { Scan } from './index';

/**
 * The set of scans Simly currently runs each cycle.
 *
 * v1: just the two consumable scans we already had pre-rewrite. Phase 4
 * adds the gear ladder (stat_weights, trinket_pre_scan, gear_coarse,
 * gear_refined, gear_final) and merges the consumables into a single
 * `consumables_gems_enchants` scan. Order doesn't affect SimC behavior
 * but affects the order of `profileset.` lines in the input — keep it
 * stable for log readability.
 */
export const SCANS: readonly Scan<unknown>[] = [
  bestFlaskScan as Scan<unknown>,
  bestFoodScan as Scan<unknown>,
  bestPotionScan as Scan<unknown>,
];

export function buildAllScanLines(): string {
  return SCANS.map((s) => s.buildLines()).join('\n\n');
}

/**
 * Wrap each scan's parsed result in a ScanRecord so the addon can show
 * status alongside data. v1 produces all-or-nothing records — when this
 * function is called, every scan in the SimC run finished, so each
 * record is either `done` (if the scan matched profilesets) or absent
 * (if it didn't). Phase 4 will fill in `pending` / `running` records
 * incrementally between SimC invocations.
 */
export function parseAllScanRecords(
  run: SimcRunResult,
  startedAt: number,
  finishedAt: number,
): ScanCollection {
  const out: ScanCollection = {};
  for (const scan of SCANS) {
    const data = scan.parseResult(run);
    if (data === undefined) continue;
    const record: ScanRecord<unknown> = {
      status: 'done',
      started_at: startedAt,
      finished_at: finishedAt,
      data,
    };
    out[scan.id] = record;
  }
  return out;
}
