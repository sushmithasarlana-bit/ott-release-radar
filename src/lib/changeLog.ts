// A saved, rolling copy of the last 8 days of Streaming Availability changes.
// Each platform group is fetched separately and newest-first, so a bulk dump on
// one platform can never crowd out the others. Each sync only asks for changes
// newer than what's already saved (~1 request per stream when nothing changed).
import { PREFS, SELECTED_PLATFORMS, type PlatformId } from "./config";
import { fetchChangePages, type SaChange, type SaShow } from "./sources/streamingAvailability";
import type { Store } from "./store";

const KEY = "sa-changelog-v2";
const DAY = 24 * 3600;
const KEEP_SECONDS = (PREFS.lookbackDays + 1) * DAY;
// Re-read the last 5 minutes in case a change is published late. Kept short:
// during a bulk dump one hour can hold 100+ changes (4 extra requests).
const OVERLAP_SECONDS = 300;

type ItemType = "show" | "season";

// Netflix + Prime add a few dozen titles a week: read them completely.
// JioHotstar re-lists its whole library at times (3,000+ entries in Oct 2026):
// read only its newest 100 per sync and record the unread part as a gap.
const STREAMS = [
  { id: "netflix-prime:show", itemType: "show", platforms: ["netflix", "prime"], maxPages: 10 },
  { id: "netflix-prime:season", itemType: "season", platforms: ["netflix", "prime"], maxPages: 10 },
  { id: "hotstar:show", itemType: "show", platforms: ["hotstar"], maxPages: 4 },
  { id: "hotstar:season", itemType: "season", platforms: ["hotstar"], maxPages: 4 },
] as const satisfies readonly { id: string; itemType: ItemType; platforms: readonly PlatformId[]; maxPages: number }[];

/** A time range we knowingly did not read (too many changes). */
export interface Gap {
  platforms: PlatformId[];
  itemType: ItemType;
  from: number;
  to: number;
}

export interface ChangeLog {
  version: 2;
  showChanges: SaChange[];
  seasonChanges: SaChange[];
  shows: Record<string, SaShow>;
  newest: Record<string, number>; // per stream id
  gaps: Gap[];
  lastSyncAt: number;
  quotaRemaining?: number | null; // RapidAPI requests left this month, as of lastSyncAt
}

export interface SyncResult {
  log: ChangeLog;
  requests: number;
  added: number;
  quotaRemaining: number | null;
  quotaLimit: number | null;
}

export function emptyChangeLog(): ChangeLog {
  return { version: 2, showChanges: [], seasonChanges: [], shows: {}, newest: {}, gaps: [], lastSyncAt: 0 };
}

export const loadChangeLog = async (store: Store) => (await store.get<ChangeLog>(KEY)) ?? emptyChangeLog();

const changeKey = (c: SaChange) => `${c.itemType}|${c.showId}|${c.service.id}|${c.season ?? ""}|${c.timestamp}`;

export async function syncChangeLog(store: Store, nowUnix: number): Promise<SyncResult> {
  const log = await loadChangeLog(store);
  const windowStart = nowUnix - PREFS.lookbackDays * DAY;
  const result: SyncResult = { log, requests: 0, added: 0, quotaRemaining: null, quotaLimit: null };

  const streams = STREAMS.map((s) => ({ ...s, platforms: s.platforms.filter((p) => SELECTED_PLATFORMS.includes(p)) })).filter(
    (s) => s.platforms.length > 0,
  );

  // Fetch in parallel, then merge one after another.
  const fetched = await Promise.all(
    streams.map(async (stream) => {
      const from = Math.max(windowStart, (log.newest[stream.id] ?? 0) - OVERLAP_SECONDS);
      return { stream, from, pages: await fetchChangePages(stream.itemType, stream.platforms, from, stream.maxPages) };
    }),
  );

  for (const { stream, from, pages } of fetched) {
    result.requests += pages.requests;
    if (pages.quotaRemaining !== null) result.quotaRemaining = Math.min(result.quotaRemaining ?? Infinity, pages.quotaRemaining);
    result.quotaLimit = pages.quotaLimit ?? result.quotaLimit;

    const list = stream.itemType === "show" ? log.showChanges : log.seasonChanges;
    const seen = new Set(list.map(changeKey));
    for (const c of pages.changes) {
      if (seen.has(changeKey(c))) continue;
      seen.add(changeKey(c));
      list.push(c);
      result.added++;
    }
    Object.assign(log.shows, pages.shows);

    const timestamps = pages.changes.map((c) => c.timestamp ?? 0);
    if (timestamps.length) log.newest[stream.id] = Math.max(log.newest[stream.id] ?? 0, ...timestamps);
    if (pages.capped) log.gaps.push({ platforms: [...stream.platforms], itemType: stream.itemType, from, to: Math.min(...timestamps) });
  }

  pruneLog(log, nowUnix);
  log.lastSyncAt = nowUnix;
  log.quotaRemaining = result.quotaRemaining;
  await store.set(KEY, log);
  return result;
}

function pruneLog(log: ChangeLog, nowUnix: number) {
  const cutoff = nowUnix - KEEP_SECONDS;
  log.showChanges = log.showChanges.filter((c) => (c.timestamp ?? 0) >= cutoff);
  log.seasonChanges = log.seasonChanges.filter((c) => (c.timestamp ?? 0) >= cutoff);
  log.gaps = log.gaps.filter((g) => g.to >= cutoff);
  const used = new Set([...log.showChanges, ...log.seasonChanges].map((c) => c.showId));
  for (const id of Object.keys(log.shows)) if (!used.has(id)) delete log.shows[id];
}
