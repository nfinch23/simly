/**
 * Strategy interface for "which SimC version should we use?"
 *
 * Default ships `LatestNightlyStrategy` which scrapes
 * downloads.simulationcraft.org/nightly/. Future strategies can swap in
 * Raidbots-mirror, Discord-webhook, manual pin, or stable-only without
 * touching the runner or installer — they all consume the same
 * SimcVersionInfo shape.
 */

export interface SimcVersionInfo {
  /** Combined identifier: "<patch>.<gitHash>" */
  tag: string;
  /** Patch portion, e.g. "1205.01". */
  patch: string;
  /** Short git hash from the filename. */
  gitHash: string;
  /** Filename of the Win64 .7z asset. */
  filename: string;
  /** Absolute download URL. */
  downloadUrl: string;
  /** Best-effort parsed publish timestamp from the directory listing. */
  publishedAt: Date;
}

export interface SimcVersionSource {
  resolveCurrent(): Promise<SimcVersionInfo>;
}

export const NIGHTLY_INDEX_URL = 'http://downloads.simulationcraft.org/nightly/?C=M;O=D';
export const NIGHTLY_BASE_URL = 'http://downloads.simulationcraft.org/nightly/';

const WIN64_FILENAME_RE = /^simc-(\d+\.\d+)\.([0-9a-f]{6,12})-win64\.7z$/;

interface ParsedRow {
  filename: string;
  publishedAt: Date;
}

/**
 * Parse an Apache mod_autoindex listing of the SimC nightly directory.
 * The page lists Mac .dmg, Win64 .7z, and WinARM64 .7z assets per build;
 * we only return the Win64 ones, in the order they appear (caller decides
 * how to pick — usually "first match" since the page is sorted by mtime
 * descending via ?C=M;O=D).
 */
export function parseNightlyIndex(html: string): SimcVersionInfo[] {
  const rowRe =
    /<a href="(simc-[^"]+\.7z)">[^<]+<\/a>\s*<\/td>\s*<td[^>]*>\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g;

  const rows: ParsedRow[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const filename = match[1]!;
    const dateStr = match[2]!;
    rows.push({ filename, publishedAt: parseListingDate(dateStr) });
  }

  const out: SimcVersionInfo[] = [];
  for (const row of rows) {
    const m = WIN64_FILENAME_RE.exec(row.filename);
    if (!m) continue;
    const [, patch, gitHash] = m;
    out.push({
      tag: `${patch}.${gitHash}`,
      patch: patch!,
      gitHash: gitHash!,
      filename: row.filename,
      downloadUrl: NIGHTLY_BASE_URL + row.filename,
      publishedAt: row.publishedAt,
    });
  }
  return out;
}

/** Apache mod_autoindex emits times in server local time without a TZ. */
function parseListingDate(s: string): Date {
  // "2026-05-01 06:19" — treat as UTC. Off by a few hours from server-local
  // is acceptable for our purposes; we're picking by relative order, and
  // any consumer that needs precision should not rely on this field.
  const iso = s.replace(' ', 'T') + ':00Z';
  return new Date(iso);
}

export type Fetcher = (url: string) => Promise<string>;

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'simly/0.0 (+https://github.com/nfinch23/simly)' },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
};

/**
 * Picks the most recent Win64 nightly. The directory listing URL is
 * already sorted by mtime descending, so this is just the first match.
 */
export class LatestNightlyStrategy implements SimcVersionSource {
  constructor(private readonly fetcher: Fetcher = defaultFetcher) {}

  async resolveCurrent(): Promise<SimcVersionInfo> {
    const html = await this.fetcher(NIGHTLY_INDEX_URL);
    const versions = parseNightlyIndex(html);
    const first = versions[0];
    if (!first) {
      throw new Error(
        `No Win64 nightly found in ${NIGHTLY_INDEX_URL}. Listing format may have changed.`,
      );
    }
    return first;
  }
}

/**
 * Compute the most recent Monday at the given UTC hour (default 23:00) at
 * or before `now`. This is the "lockout boundary" used by
 * MondayWeeklyStrategy — every nightly published <= this timestamp is
 * eligible for "this week's pin," and we hold that pin until the next
 * Monday boundary passes.
 *
 * Mirrors Raidbots' weekly cadence: they rebuild Monday night and hold
 * for the lockout. We don't try to match their exact pick (no public feed
 * exposes it) — we apply the same selection rule to the same source.
 */
export function mostRecentMondayBoundary(now: Date, hourUtc = 23): Date {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Days back to most recent Monday (Mon=0, Tue=1, ..., Sun=6)
  let daysSinceMonday = (day + 6) % 7;
  // If today IS Monday but we're earlier than the boundary hour, the
  // most recent passed boundary is the previous Monday.
  if (daysSinceMonday === 0 && d.getUTCHours() < hourUtc) {
    daysSinceMonday = 7;
  }
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/**
 * Picks the most recent nightly published at or before the most recent
 * Monday 23:00 UTC. Mirrors Raidbots' "weekly" cadence using SimC's own
 * nightly listing — see SCOPE.md section 6 phase 2 for context.
 *
 * Falls back to the oldest available nightly if nothing is older than
 * the boundary (rare; only happens if the listing was just wiped or the
 * boundary clock is very wrong). That keeps the app usable instead of
 * surfacing a strategy error.
 */
export class MondayWeeklyStrategy implements SimcVersionSource {
  constructor(
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly clock: () => Date = () => new Date(),
    private readonly boundaryHourUtc = 23,
  ) {}

  async resolveCurrent(): Promise<SimcVersionInfo> {
    const html = await this.fetcher(NIGHTLY_INDEX_URL);
    const versions = parseNightlyIndex(html);
    if (versions.length === 0) {
      throw new Error(
        `No Win64 nightly found in ${NIGHTLY_INDEX_URL}. Listing format may have changed.`,
      );
    }
    const boundary = mostRecentMondayBoundary(this.clock(), this.boundaryHourUtc);
    const eligible = versions.find(
      (v) => v.publishedAt.getTime() <= boundary.getTime(),
    );
    if (eligible) return eligible;
    // Nothing is older than the boundary — every nightly was published
    // after our most recent Monday. Fall back to the oldest entry.
    return versions[versions.length - 1]!;
  }
}
