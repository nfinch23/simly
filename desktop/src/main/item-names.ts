/**
 * Item-name lookup. Backs the "Best content to chase" table and the
 * addon panel with readable names instead of raw item IDs.
 *
 * Sourced from SimC's `item_data.inc` via `scripts/regen-item-names.mjs`.
 * Coverage is ~85% of the dungeon/raid pool — newly-added items lag the
 * SimC midnight branch's update cadence by a few days. The lookup
 * returns a `Item #<id>` fallback for misses so the UI always has
 * something to render.
 */
import namesData from '../../../data/item-names.json';

const NAMES = (namesData.names ?? {}) as Record<string, string>;

/**
 * Get the display name for an item id. Returns a `Item #<id>` fallback
 * when the name isn't in the data file — happens for very-recent items
 * the SimC midnight branch hasn't ingested yet.
 */
export function getItemName(itemId: number): string {
  const name = NAMES[String(itemId)];
  if (name) return name;
  return `Item #${itemId}`;
}

/** True when we have an authoritative name (no fallback). */
export function hasItemName(itemId: number): boolean {
  return String(itemId) in NAMES;
}

/** Coverage statistics — surfaces in the UI's status section if useful. */
export function getNameCoverage(): { count: number; source: string } {
  return {
    count: Number(namesData.count ?? Object.keys(NAMES).length),
    source: String(namesData.source ?? 'unknown'),
  };
}
