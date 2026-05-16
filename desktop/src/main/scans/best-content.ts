/**
 * Phase 7 — best-content scan.
 *
 * For each item the player could acquire from the content they enabled
 * in the picker (M+ at the picked max level + each enabled raid difficulty),
 * sim it as a slot swap against the converged winning loadout. The output
 * answers: "what should I be chasing, ranked by DPS gain."
 *
 * v1 assumes infinite crests: each candidate is simmed at its track's
 * max-upgrade ilvl. The follow-up crest-spend slice will weight by crest
 * cost. See `desktop/src/main/content-pool.ts` for the pure resolution
 * logic; this module only handles SimC orchestration + result parsing.
 *
 * Like upgrade-priority, this scan does NOT register in `SCANS[]` — it
 * needs the gear_final winner as context, available only after compose.
 */
import type { BestContentResult, ContentOpportunity } from '@simly/shared';
import { runSimc, type RunnerPaths, type SimcRunResult } from '../simc-runner';
import { buildProfilesetLines, matchProfilesetsByPrefix, roundTo } from './index';
import { resolveContentPool, type ContentCandidate } from '../content-pool';
import { getItemName } from '../item-names';
import type { ContentPrefs } from '../settings';
import type { ParsedItem } from '../simc-export-parser';

/**
 * Per-source grouping of content opportunities. Each source (e.g.
 * "Operation: Mechagon - Workshop M+ +10", "Heroic raid") gets one
 * GroupedSource with the opportunities that ranked as upgrades plus
 * a simple "potential value" total = sum of delta_dps across the
 * source's upgrades.
 *
 * Used by the addon panel's Slice J "Sim Dungeons" / "Sim Raids" view
 * to answer: "for this dungeon, how many upgrades are available and
 * what's the total DPS I'd gain by farming it?"
 *
 * True expected value (drop-chance × dps-gain) is deferred — KeystoneLoot
 * data has the per-source loot pool but not per-item drop probability.
 * Total-potential-gain is the v1 EV proxy.
 */
export interface GroupedSource {
  source_label: string;
  source_category: 'mplus' | 'raid';
  upgrade_count: number;
  /** Sum of delta_dps across upgrades (delta_dps > 0 only). */
  total_potential_dps: number;
  /** All upgrades from this source, sorted desc by delta_dps. */
  opportunities: readonly ContentOpportunity[];
}

/**
 * Group content opportunities by source_label and compute per-source
 * upgrade count + total potential DPS. Sources with zero upgrades are
 * excluded. Result is sorted desc by total_potential_dps so the most-
 * valuable source surfaces first.
 *
 * Pure function — no IO. Exported so the addon-format helper and
 * tests can both use it.
 */
export function groupContentBySource(
  opportunities: readonly ContentOpportunity[],
): GroupedSource[] {
  const byLabel = new Map<string, GroupedSource>();
  for (const op of opportunities) {
    if (op.delta_dps <= 0) continue;
    let group = byLabel.get(op.source_label);
    if (!group) {
      group = {
        source_label: op.source_label,
        source_category: op.source_category,
        upgrade_count: 0,
        total_potential_dps: 0,
        opportunities: [],
      };
      byLabel.set(op.source_label, group);
    }
    group.upgrade_count += 1;
    group.total_potential_dps += op.delta_dps;
    (group.opportunities as ContentOpportunity[]).push(op);
  }
  for (const group of byLabel.values()) {
    (group.opportunities as ContentOpportunity[]).sort(
      (a, b) => b.delta_dps - a.delta_dps,
    );
  }
  return Array.from(byLabel.values()).sort(
    (a, b) => b.total_potential_dps - a.total_potential_dps,
  );
}

/** Hard cap on profilesets per run. 60 × 3000 iter ≈ 10 min on a typical box. */
export const MAX_BEST_CONTENT_COMBOS = 60;

export const ITERATIONS_DEFAULT = 3000;

export const PROFILESET_PREFIX = 'content';
const BASELINE_KEY = 'baseline';

export interface BestContentScanOptions {
  paths: RunnerPaths;
  /** The converged actor's full SimC profile. Used unmodified as the run's base. */
  baseProfile: string;
  /** Player's class name from the SimC export. */
  className: string;
  /** Player's spec key from the SimC export. */
  specKey: string;
  /** User's enabled-content selection. */
  prefs: ContentPrefs;
  /**
   * Resolved winning loadout per slot. Used to skip candidates that don't
   * improve over the player's current ilvl in that slot (no point simming
   * a Hero-track drop when they're already in Myth gear).
   */
  composedGear: Record<string, ParsedItem>;
  iterations?: number;
  maxCombos?: number;
  onProgress?: Parameters<typeof runSimc>[0]['onProgress'];
  /** Test-only override to bypass SimC. */
  runOverride?: (profileScript: string) => Promise<SimcRunResult>;
}

interface CandidateWithKey extends ContentCandidate {
  /** Profileset suffix — unique per candidate. */
  key: string;
  /** Slot the candidate would land in (resolves finger / trinket ambiguity). */
  simc_slot: string;
}

/**
 * Pre-filter the pool: drop candidates whose target_ilvl doesn't beat the
 * player's current item in that slot. (Composer gives us the winner's
 * per-slot ilvl.) Then cap at `maxCombos`, keeping the highest-ilvl
 * candidates first.
 */
export function selectContentCandidates(opts: {
  prefs: ContentPrefs;
  className: string;
  specKey: string;
  composedGear: Record<string, ParsedItem>;
  maxCombos?: number;
}): { selected: CandidateWithKey[]; totalConsidered: number } {
  const pool = resolveContentPool({
    prefs: opts.prefs,
    className: opts.className,
    specKey: opts.specKey,
  });

  const filtered: CandidateWithKey[] = [];
  for (const c of pool) {
    const simcSlot = resolveSimcSlot(c.slot, opts.composedGear);
    const current = opts.composedGear[simcSlot];
    if (!current) {
      // Slot isn't equipped (e.g. shirt/tabard, or off_hand on a 2H build).
      // Skip — no baseline to compare against.
      continue;
    }
    if (c.target_ilvl <= current.ilvl) continue; // not an upgrade
    filtered.push({
      ...c,
      simc_slot: simcSlot,
      key: `${simcSlot}_${c.item_id}`,
    });
  }

  filtered.sort((a, b) => b.target_ilvl - a.target_ilvl);
  const cap = opts.maxCombos ?? MAX_BEST_CONTENT_COMBOS;
  const selected = filtered.slice(0, cap);
  return { selected, totalConsidered: pool.length };
}

/**
 * Resolve ambiguous slot names from the pool ('finger' / 'trinket' map to
 * either of two numbered slots). Pick the slot that has the lower-ilvl
 * equipped item — replacing the weaker side is the bigger gain.
 */
function resolveSimcSlot(
  poolSlot: string,
  composedGear: Record<string, ParsedItem>,
): string {
  if (poolSlot === 'finger') {
    const a = composedGear.finger1?.ilvl ?? 0;
    const b = composedGear.finger2?.ilvl ?? 0;
    return a <= b ? 'finger1' : 'finger2';
  }
  if (poolSlot === 'trinket') {
    const a = composedGear.trinket1?.ilvl ?? 0;
    const b = composedGear.trinket2?.ilvl ?? 0;
    return a <= b ? 'trinket1' : 'trinket2';
  }
  return poolSlot;
}

/**
 * Build the SimC profileset block. Baseline is the player's current
 * item in the anchor slot (re-emitted verbatim so SimC's baseline run
 * matches the converged actor). Each variant overrides one slot with
 * `<slot>=,id=<itemId>,ilevel=<targetIlvl>` — SimC synthesizes stats at
 * that ilvl without us needing bonus_ids.
 */
export function buildBestContentProfilesets(
  candidates: CandidateWithKey[],
  composedGear: Record<string, ParsedItem>,
): string {
  if (candidates.length === 0) return '';
  // Anchor baseline against a stable slot the loadout actually has —
  // first candidate's slot is guaranteed present (selectContentCandidates
  // filters that). Re-paste the equipped item line as the baseline body.
  const anchorSlot = candidates[0]!.simc_slot;
  const anchorItem = composedGear[anchorSlot]!;
  const baselineBody = formatItemLineFromParsed(anchorItem, anchorSlot);
  const lines = [{ key: BASELINE_KEY, simcLine: baselineBody }];
  for (const c of candidates) {
    lines.push({
      key: c.key,
      simcLine: `${c.simc_slot}=,id=${c.item_id},ilevel=${c.target_ilvl}`,
    });
  }
  return buildProfilesetLines(PROFILESET_PREFIX, lines);
}

function formatItemLineFromParsed(item: ParsedItem, slotOverride: string): string {
  const parts = [`${slotOverride}=,id=${item.item_id}`];
  if (item.bonus_ids.length > 0) parts.push(`bonus_id=${item.bonus_ids.join('/')}`);
  if (item.crafted_stats?.length) parts.push(`crafted_stats=${item.crafted_stats.join('/')}`);
  if (item.crafting_quality !== undefined) parts.push(`crafting_quality=${item.crafting_quality}`);
  return parts.join(',');
}

export function parseBestContentResult(
  run: SimcRunResult,
  candidates: CandidateWithKey[],
  totalConsidered: number,
): BestContentResult {
  const psNames = [
    { key: BASELINE_KEY },
    ...candidates.map((c) => ({ key: c.key })),
  ];
  const matched = matchProfilesetsByPrefix(run, PROFILESET_PREFIX, psNames);
  const byKey = new Map<string, number>();
  for (const m of matched) byKey.set(m.candidate.key, m.mean);

  const baseline = byKey.get(BASELINE_KEY) ?? 0;

  const opportunities: ContentOpportunity[] = candidates.flatMap((c) => {
    const upgraded = byKey.get(c.key);
    if (upgraded === undefined) return [];
    const delta = upgraded - baseline;
    const deltaPct = baseline > 0 ? (delta / baseline) * 100 : 0;
    return [
      {
        item_id: c.item_id,
        name: getItemName(c.item_id),
        slot: c.simc_slot,
        target_ilvl: c.target_ilvl,
        source_label: c.source_label,
        source_category: c.source_category,
        current_dps: Math.round(baseline),
        upgraded_dps: Math.round(upgraded),
        delta_dps: Math.round(delta),
        delta_pct: roundTo(deltaPct, 3),
      },
    ];
  });

  opportunities.sort((a, b) => b.delta_dps - a.delta_dps);

  return {
    label: 'Best content (max-upgrade, estimated)',
    baseline_dps: Math.round(baseline),
    candidates_evaluated: totalConsidered,
    opportunities,
  };
}

export async function runBestContentScan(
  opts: BestContentScanOptions,
): Promise<BestContentResult> {
  const { selected, totalConsidered } = selectContentCandidates({
    prefs: opts.prefs,
    className: opts.className,
    specKey: opts.specKey,
    composedGear: opts.composedGear,
    maxCombos: opts.maxCombos,
  });

  if (selected.length === 0) {
    return {
      label: 'Best content (max-upgrade, estimated)',
      baseline_dps: 0,
      candidates_evaluated: totalConsidered,
      opportunities: [],
    };
  }

  const iterations = opts.iterations ?? ITERATIONS_DEFAULT;
  const lines = buildBestContentProfilesets(selected, opts.composedGear);
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

  return parseBestContentResult(run, selected, totalConsidered);
}
