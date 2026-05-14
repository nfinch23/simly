/**
 * Phase 7 — upgrade-priority scan.
 *
 * For each item in the converged winning loadout, sim a variant where
 * that one slot is bumped by `+ILVL_PER_TIER` (default 13, the dominant
 * Midnight track step). Rank by DPS gain to answer:
 *
 *   "Which slot pays off most from the next tier upgrade?"
 *
 * This is rank-accurate but DPS-approximate — we don't model real
 * bonus_id rewriting because SimC's upgrade-tier mapping isn't directly
 * decodable from item_bonus.inc without runtime logic. The ilvl override
 * gives SimC enough to rescale the item's stats; what we lose is any
 * non-linear bonus-spell changes that real bonus_id swaps would model.
 *
 * The scan does NOT register in `SCANS[]` (the static registry) — it
 * depends on the gear_final winner, which isn't available at registry
 * construction time. Instead it's invoked directly from `scan-queue.ts`
 * after the gear ladder converges, in the same style as `gear-full-sim`.
 */
import type { ComposedLoadout } from '@simly/shared';
import type { ParsedExport, ParsedItem, SlotName } from '../simc-export-parser';
import { formatItemLine } from '../simc-export-parser';
import type { UpgradeOpportunity, UpgradePriorityResult } from '@simly/shared';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import { buildProfilesetLines, matchProfilesetsByPrefix, roundTo } from './index';
import { rewriteToNextRank } from '../upgrade-track-lookup';

/**
 * Fallback per-rank ilvl bump used only when we can't detect the item's
 * upgrade track from its bonus_ids (crafted items, world-quest rewards,
 * etc.). The PRIMARY path uses real track data from upgrade-tracks.json
 * via `rewriteToNextRank` — within a track, real ranks step by +3 or +4
 * ilvl, not +13. The +13 here is intentionally conservative on the high
 * side so untrackable items still surface as candidates rather than
 * being silently dropped.
 */
export const ILVL_PER_TIER = 13;

/**
 * Items at or above this ilvl are skipped — assumed already at the Myth
 * ceiling and not realistically upgradeable in v1. Conservative cutoff;
 * if a real Myth item lands at a different ceiling we'll see false-positive
 * suggestions and tighten then.
 */
export const MYTH_CEILING = 289;

export const ITERATIONS_DEFAULT = 3000;

export const PROFILESET_PREFIX = 'upgrade';
const BASELINE_KEY = 'baseline';

export interface UpgradePriorityOptions {
  paths: RunnerPaths;
  /** The converged actor's full SimC profile. Used unmodified as the run's base. */
  baseProfile: string;
  /**
   * Per-slot winning gear from gear_final. Map key = slot name
   * (head / neck / … / trinket2). Only items in this map are considered;
   * any slot omitted is silently skipped.
   */
  composedGear: Record<string, ParsedItem>;
  iterations?: number;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
  /**
   * Test-only override: skip the actual SimC subprocess and use the
   * provided pre-built run instead. Lets the unit tests assert profileset
   * names + DPS-delta math without spinning a binary.
   */
  runOverride?: (profileScript: string) => Promise<SimcRunResult>;
}

interface SlotCandidate {
  /** Profileset key suffix — `<PROFILESET_PREFIX>_<key>`. */
  key: string;
  slot: string;
  item: ParsedItem;
  next_ilvl: number;
  /**
   * When non-null, the item's track was identified and we'll model the
   * upgrade by swapping the rank's bonus_id (the most accurate path).
   * When null, we fall back to an `ilevel=<N>` override on the item line.
   */
  rewritten_bonus_ids: number[] | null;
  /** Which track this item sits in, for diagnostics. Null when no track detected. */
  track_label: string | null;
}

/**
 * Build the SimC profileset block for the upgrade-priority sim. Public for
 * unit tests; the runner composes this onto the baseProfile internally.
 */
export function buildUpgradePriorityProfilesets(
  composedGear: Record<string, ParsedItem>,
): { lines: string; candidates: SlotCandidate[] } {
  const candidates: SlotCandidate[] = [];

  for (const [slot, item] of Object.entries(composedGear)) {
    if (!item || item.ilvl <= 0) continue;
    if (item.ilvl >= MYTH_CEILING) continue;

    // Primary path: detect upgrade track from bonus_ids, model the +1
    // rank as a bonus_id swap. SimC reads the real rank's bonus_id and
    // applies the authoritative ilvl + stat scaling. Returns null when
    // the item is at the track ceiling (rank 6/6) or has no detectable
    // track — those cases fall through to the +13 approximation, with
    // the ceiling case being filtered by the rewrite returning null.
    const rewrite = rewriteToNextRank(item.bonus_ids);

    if (rewrite) {
      candidates.push({
        key: slot,
        slot,
        item,
        next_ilvl: rewrite.next.ilvl,
        rewritten_bonus_ids: rewrite.bonus_ids,
        track_label: `${rewrite.position.track} ${rewrite.position.rank + 1}/${rewrite.position.all_ranks.length}`,
      });
      continue;
    }

    // Fallback for untrackable items (crafted, world-quest, etc.).
    // ilvl override is approximate but at least surfaces the slot as a
    // candidate so the user knows it might be worth checking.
    candidates.push({
      key: slot,
      slot,
      item,
      next_ilvl: item.ilvl + ILVL_PER_TIER,
      rewritten_bonus_ids: null,
      track_label: null,
    });
  }

  // No candidates ⇒ no sim work to do. Skip the baseline anchor too;
  // the caller short-circuits on empty `candidates` before building a
  // profile.
  if (candidates.length === 0) {
    return { lines: '', candidates: [] };
  }

  // Baseline profileset: a no-op override so we get a clean baseline DPS
  // alongside the variants. Pinning it to the actor's existing head is a
  // safe no-op (SimC re-applies the same item line on top of the base
  // profile, leaving the actor unchanged).
  const baselineAnchor = Object.values(composedGear).find((it) => it && it.ilvl > 0);
  const baselineLine = baselineAnchor ? formatItemLine(baselineAnchor) : '';

  const psCandidates = [
    { key: BASELINE_KEY, simcLine: baselineLine },
    ...candidates.map((c) => ({
      key: c.key,
      simcLine: formatVariantLine(c),
    })),
  ].filter((c) => c.simcLine.length > 0);

  return {
    lines: buildProfilesetLines(PROFILESET_PREFIX, psCandidates),
    candidates,
  };
}

/**
 * Emit the SimC profileset body for one upgrade variant. Uses the
 * bonus_id rewrite when available (authoritative path) and falls back
 * to an `ilevel=<N>` override when the item has no track marker.
 */
function formatVariantLine(c: SlotCandidate): string {
  const slot = c.slot as Parameters<typeof formatItemLine>[1];
  if (c.rewritten_bonus_ids) {
    // Replace the item's bonus_ids with the next-rank set. The base
    // formatItemLine path emits the current bonus_ids, so we substitute
    // them via a shallow clone before formatting.
    const rewritten: ParsedItem = { ...c.item, bonus_ids: c.rewritten_bonus_ids };
    return formatItemLine(rewritten, slot);
  }
  // Fallback path: ilevel override (the original approximation).
  return `${formatItemLine(c.item, slot)},ilevel=${c.next_ilvl}`;
}

export function parseUpgradePriorityResult(
  run: SimcRunResult,
  candidates: SlotCandidate[],
): UpgradePriorityResult {
  const psNames = [
    { key: BASELINE_KEY },
    ...candidates.map((c) => ({ key: c.key })),
  ];
  const matched = matchProfilesetsByPrefix(run, PROFILESET_PREFIX, psNames);

  const byKey = new Map<string, number>();
  for (const m of matched) byKey.set(m.candidate.key, m.mean);

  const baseline = byKey.get(BASELINE_KEY) ?? 0;

  const opportunities: UpgradeOpportunity[] = candidates.flatMap((c) => {
    const upgraded = byKey.get(c.key);
    if (upgraded === undefined) return [];
    const delta = upgraded - baseline;
    const deltaPct = baseline > 0 ? (delta / baseline) * 100 : 0;
    return [
      {
        slot: c.slot,
        item_id: c.item.item_id,
        name: c.item.name,
        current_ilvl: c.item.ilvl,
        next_ilvl: c.next_ilvl,
        current_dps: Math.round(baseline),
        upgraded_dps: Math.round(upgraded),
        delta_dps: Math.round(delta),
        delta_pct: roundTo(deltaPct, 3),
      },
    ];
  });

  opportunities.sort((a, b) => b.delta_dps - a.delta_dps);

  return {
    label: 'Upgrade priority (+1 tier, estimated)',
    baseline_dps: Math.round(baseline),
    ilvl_per_tier: ILVL_PER_TIER,
    opportunities,
  };
}

/**
 * Back-resolve the composer's serializable gear refs to the runtime
 * `ParsedItem` objects. We need the bonus_id list + raw stats to emit
 * a faithful SimC item line — `ComposedGearItem` only carries item_id +
 * name. Match strategy: look in `parsedExport.poolBySlot[slot]` first,
 * fall back to `equipped` (handles cases where the pool was deduped to
 * a different identity but the equipped copy is still around).
 *
 * Silently drops any slot that can't be resolved (defensive — partial
 * results are better than aborting the scan entirely).
 */
export function resolveComposedToParsedItems(
  composedGear: NonNullable<ComposedLoadout['gear']>,
  parsedExport: ParsedExport,
): Record<string, ParsedItem> {
  const out: Record<string, ParsedItem> = {};
  for (const [slot, ref] of Object.entries(composedGear)) {
    if (!ref) continue;
    const pool = parsedExport.poolBySlot[slot as SlotName] ?? [];
    const fromPool = pool.find((it) => it.item_id === ref.item_id);
    if (fromPool) {
      out[slot] = fromPool;
      continue;
    }
    const fromEquipped = parsedExport.equipped.find(
      (it) => it.item_id === ref.item_id && it.slot === slot,
    );
    if (fromEquipped) {
      out[slot] = fromEquipped;
    }
  }
  return out;
}

export async function runUpgradePriorityScan(
  opts: UpgradePriorityOptions,
): Promise<UpgradePriorityResult> {
  const { lines, candidates } = buildUpgradePriorityProfilesets(opts.composedGear);
  if (candidates.length === 0) {
    return {
      label: 'Upgrade priority (+1 tier, estimated)',
      baseline_dps: 0,
      ilvl_per_tier: ILVL_PER_TIER,
      opportunities: [],
    };
  }

  const iterations = opts.iterations ?? ITERATIONS_DEFAULT;
  const profileScript = [
    opts.baseProfile,
    '',
    `iterations=${iterations}`,
    lines,
  ].join('\n');

  const run = opts.runOverride
    ? await opts.runOverride(profileScript)
    : await runSimc({
        paths: opts.paths,
        profileScript,
        onProgress: opts.onProgress,
      });

  return parseUpgradePriorityResult(run, candidates);
}
