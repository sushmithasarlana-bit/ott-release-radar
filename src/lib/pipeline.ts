// The full run: Streaming Availability -> TMDB -> filters -> Gemini.
// Returns plain JSON (DigestData) so it can be cached, shown on the page and
// formatted for Telegram. Never throws for a single API failing: it records a
// note saying which API failed and carries on with what it has.
import { buildCandidates, type CandidateKind, type PlatformAvailability } from "./candidates";
import { loadChangeLog, syncChangeLog, type ChangeLog } from "./changeLog";
import { PLATFORMS, PREFS, PREFS_VERSION } from "./config";
import { enrichAndFilter } from "./enrich";
import { ApiError } from "./http";
import { MAX_TITLES_PER_CALL, getVerdicts, type Verdict } from "./sources/gemini";
import { discoverRecentTitles } from "./sources/tmdbDiscover";
import type { Store } from "./store";

const DAY = 24 * 3600;
// Below this many RapidAPI requests left this month, test-page runs stop calling
// Streaming Availability and reuse saved data, keeping the rest for Fridays.
const QUOTA_RESERVE = 100;

export interface PipelineOptions {
  /** Test-page runs: true. The Friday digest: false (it may use the reserve). */
  reserveQuota: boolean;
}

export interface DigestTitle {
  id: string;
  title: string;
  kind: CandidateKind;
  seasonsAdded: number[];
  platforms: PlatformAvailability[];
  link: string | null; // platform link, else TMDB page, else none
  language: string | null;
  genres: string[];
  runtime: number | null;
  episodes: number | null;
  episodesScope: "season" | "added" | "series" | null;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  verdict: Verdict;
}

export interface Funnel {
  changes: number;
  newTitles: number; // unique titles, after bulk re-listings were left out
  bulkRelistingExcluded: number;
  inLanguage: number;
  languageUnknown: number;
  inGenre: number;
  watch: number;
  skip: number;
}

export type SourceStatus = "ok" | "saved-data" | "failed" | "skipped";

export interface DigestData {
  generatedAt: number;
  prefsVersion: string; // changes when config/preferences.json changes, so old caches are ignored
  limitedData: boolean; // true when built from TMDB's fallback list (availability dates unknown)
  window: { from: number; to: number };
  titles: DigestTitle[];
  funnel: Funnel;
  sources: {
    streamingAvailability: { status: SourceStatus; requests: number; quotaRemaining: number | null; quotaLimit: number | null };
    tmdb: { status: SourceStatus; fromTmdb: number; fromFallback: number };
    gemini: { status: SourceStatus; model: string | null; usedBackup: boolean };
  };
  notes: string[]; // plain-language warnings: which API failed, what we did instead
  timingsMs: Record<string, number>;
}

const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "unexpected error");

export async function runPipeline(store: Store, opts: PipelineOptions, nowUnix = Math.floor(Date.now() / 1000)): Promise<DigestData> {
  const notes: string[] = [];
  const timingsMs: Record<string, number> = {};
  const time = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timingsMs[step] = Date.now() - t;
    }
  };
  const window = { from: nowUnix - PREFS.lookbackDays * DAY, to: nowUnix };

  // 1. What's new (Streaming Availability), falling back to the saved copy,
  //    and if that is too old, to TMDB's list of recent releases ("limited data").
  const sa: DigestData["sources"]["streamingAvailability"] = { status: "ok", requests: 0, quotaRemaining: null, quotaLimit: null };
  let log: ChangeLog = await loadChangeLog(store);
  const savedIsRecent = log.lastSyncAt > nowUnix - DAY;
  const lowQuota = typeof log.quotaRemaining === "number" && log.quotaRemaining < QUOTA_RESERVE;

  if (opts.reserveQuota && lowQuota && savedIsRecent) {
    sa.status = "saved-data";
    sa.quotaRemaining = log.quotaRemaining ?? null;
    notes.push(`Only ${log.quotaRemaining} RapidAPI requests left this month, so this run reused data saved ${hoursAgo(log.lastSyncAt, nowUnix)} (the rest is kept for the Friday digest).`);
  } else {
    try {
      const sync = await time("streamingAvailability", () => syncChangeLog(store, nowUnix));
      log = sync.log;
      Object.assign(sa, { requests: sync.requests, quotaRemaining: sync.quotaRemaining, quotaLimit: sync.quotaLimit });
    } catch (err) {
      sa.status = savedIsRecent ? "saved-data" : "failed";
      notes.push(
        savedIsRecent
          ? `Streaming Availability is unavailable (${errorText(err)}). Using data saved ${hoursAgo(log.lastSyncAt, nowUnix)}.`
          : `Streaming Availability is unavailable (${errorText(err)}). Limited data this week: using TMDB's list of recent releases on these platforms instead, so "available since" dates are unknown.`,
      );
    }
  }
  if (sa.status !== "failed" && log.gaps.some((g) => g.to >= window.from)) {
    const platforms = [...new Set(log.gaps.flatMap((g) => g.platforms))].map((p) => PLATFORMS[p].name).join(", ");
    notes.push(`Very large number of additions on ${platforms} this week (a catalog re-listing): only the newest ones were checked.`);
  }

  let built = buildCandidates(sa.status === "failed" ? { showChanges: [], seasonChanges: [], shows: {} } : log, window.from, window.to);
  if (sa.status === "failed") {
    try {
      const found = await time("tmdbDiscover", () => discoverRecentTitles(window));
      built = { ...built, candidates: found, counts: { ...built.counts, uniqueTitles: found.length } };
    } catch (err) {
      notes.push(`TMDB's fallback list also failed (${errorText(err)}), so there are no titles to show.`);
    }
  }
  const { candidates, counts: fetchCounts } = built;
  if (fetchCounts.bulkRelistingExcluded)
    notes.push(`${fetchCounts.bulkRelistingExcluded} older titles re-listed in bulk were left out (only titles from last year or this year count on bulk days).`);

  // 2. What is it (TMDB) + filters.
  const { kept, counts } = await time("tmdb", () => enrichAndFilter(candidates, store));
  const tmdbStatus: SourceStatus = candidates.length === 0 ? "skipped" : counts.tmdbDetails === 0 ? "failed" : "ok";
  for (const e of counts.tmdbErrors) notes.push(`TMDB failed for some titles (${e}); used Streaming Availability's details for them.`);
  if (counts.languageUnknown)
    notes.push(`${counts.languageUnknown} ${counts.languageUnknown === 1 ? "title was" : "titles were"} left out because the language could not be checked (TMDB failed).`);

  // 3. Watch or skip (Gemini), one batched call.
  const gemini = await time("gemini", () => getVerdicts(kept));
  if (gemini.error) notes.push(`AI verdict unavailable: ${gemini.error}`);
  if (kept.length > MAX_TITLES_PER_CALL)
    notes.push(`${kept.length} titles matched, more than one AI call handles (${MAX_TITLES_PER_CALL}); the rest show "AI verdict unavailable".`);
  if (gemini.usedBackup) notes.push(`Main Gemini model failed; the backup model (${gemini.model}) answered.`);

  const titles: DigestTitle[] = kept.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    seasonsAdded: t.seasonsAdded,
    platforms: t.platforms,
    link: t.platforms.find((p) => p.link)?.link ?? t.details.fallbackLink,
    language: t.details.originalLanguage,
    genres: t.details.genres,
    runtime: t.details.runtime,
    episodes: t.details.episodes,
    episodesScope: t.details.episodesScope,
    year: t.details.year,
    poster: t.details.poster,
    backdrop: t.details.backdrop,
    verdict: gemini.verdicts.get(t.id)!,
  }));
  titles.sort(byVerdict);

  return {
    generatedAt: nowUnix,
    prefsVersion: PREFS_VERSION,
    limitedData: sa.status === "failed",
    window,
    titles,
    funnel: {
      changes: fetchCounts.titleChanges + fetchCounts.seasonChanges,
      newTitles: fetchCounts.uniqueTitles,
      bulkRelistingExcluded: fetchCounts.bulkRelistingExcluded,
      inLanguage: counts.inLanguage,
      languageUnknown: counts.languageUnknown,
      inGenre: counts.inGenre,
      watch: titles.filter((t) => t.verdict.verdict === "WATCH").length,
      skip: titles.filter((t) => t.verdict.verdict === "SKIP").length,
    },
    sources: {
      streamingAvailability: sa,
      tmdb: { status: tmdbStatus, fromTmdb: counts.tmdbDetails, fromFallback: counts.fallbackDetails },
      gemini: { status: kept.length === 0 ? "skipped" : gemini.model ? "ok" : "failed", model: gemini.model, usedBackup: gemini.usedBackup },
    },
    notes,
    timingsMs,
  };
}

// WATCH first, then SKIP, then no verdict; higher score first; newest first on ties.
function byVerdict(a: DigestTitle, b: DigestTitle): number {
  const rank = (t: DigestTitle) => (t.verdict.verdict === "WATCH" ? 0 : t.verdict.verdict === "SKIP" ? 1 : 2);
  const newest = (t: DigestTitle) => Math.max(...t.platforms.map((p) => p.since));
  return rank(a) - rank(b) || (b.verdict.score ?? 0) - (a.verdict.score ?? 0) || newest(b) - newest(a);
}

function hoursAgo(unix: number, nowUnix: number): string {
  const h = Math.round((nowUnix - unix) / 3600);
  return h < 1 ? "less than an hour ago" : `${h} hour${h === 1 ? "" : "s"} ago`;
}
