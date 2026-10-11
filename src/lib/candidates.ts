// Turns raw Streaming Availability changes into one entry per title.
import { PLATFORMS, SELECTED_PLATFORMS, isSelectedPlatform, type PlatformId } from "./config";
import type { Gap } from "./changeLog";
import type { SaChange, SaShow } from "./sources/streamingAvailability";

export interface SaWeek {
  showChanges: SaChange[];
  seasonChanges: SaChange[];
  shows: Record<string, SaShow>;
  gaps?: Gap[];
}

// A platform adding this many titles+seasons in one day is re-listing its
// library, not releasing new things. On such days only recent titles count.
const BULK_DAY_THRESHOLD = 150;

/** A platform and IST day on which a bulk re-listing happened. */
export interface BulkDay {
  platform: PlatformId;
  day: string; // YYYY-MM-DD, India time
  changesSeen: number;
  partlyRead: boolean; // true if we skipped some of that day's changes
}

export interface PlatformAvailability {
  platform: PlatformId;
  name: string;
  since: number; // unix seconds: when it became available on this platform
  link: string | null; // only links the API provided
}

// movie / series: the title itself is new to the platform.
// newSeason: an existing series got one or more seasons added.
export type CandidateKind = "movie" | "series" | "newSeason";

export interface SaDetails {
  overview: string | null;
  genres: string[];
  runtime: number | null;
  episodeCount: number | null;
  seasonCount: number | null;
  year: number | null;
}

export interface Candidate {
  id: string;
  tmdbId: string | null; // "movie/123" or "tv/456"
  title: string;
  kind: CandidateKind;
  seasonsAdded: number[];
  platforms: PlatformAvailability[];
  saDetails: SaDetails; // fallback if TMDB fails for this title
}

export interface FetchCounts {
  titleChanges: number;
  seasonChanges: number;
  outsideWindow: number;
  otherPlatformOrType: number;
  missingDetails: number;
  bulkRelistingExcluded: number;
  uniqueTitles: number;
  movies: number;
  series: number;
  newSeasons: number;
}

export function buildCandidates(week: SaWeek, fromUnix: number, toUnix: number) {
  const counts: FetchCounts = {
    titleChanges: week.showChanges.length,
    seasonChanges: week.seasonChanges.length,
    outsideWindow: 0,
    otherPlatformOrType: 0,
    missingDetails: 0,
    bulkRelistingExcluded: 0,
    uniqueTitles: 0,
    movies: 0,
    series: 0,
    newSeasons: 0,
  };

  // Strict checks in our own code, even though the API was asked for the same.
  const keep = (c: SaChange) => {
    if (!isSelectedPlatform(c.service.id) || c.streamingOptionType !== "subscription") {
      counts.otherPlatformOrType++;
      return false;
    }
    if (!c.timestamp || c.timestamp < fromUnix || c.timestamp > toUnix) {
      counts.outsideWindow++;
      return false;
    }
    return true;
  };

  const groups = new Map<string, { titles: SaChange[]; seasons: SaChange[] }>();
  const group = (id: string) => groups.get(id) ?? groups.set(id, { titles: [], seasons: [] }).get(id)!;
  for (const c of week.showChanges.filter(keep)) group(c.showId).titles.push(c);
  for (const c of week.seasonChanges.filter(keep)) if (typeof c.season === "number") group(c.showId).seasons.push(c);

  const bulkDays = findBulkDays(week, groups, fromUnix, toUnix);
  const isBulk = (p: PlatformAvailability) => bulkDays.some((b) => b.platform === p.platform && b.day === istDay(p.since));
  const recentFrom = Number(istDay(toUnix).slice(0, 4)) - 1; // this year and last year

  const candidates: Candidate[] = [];
  for (const [id, { titles, seasons }] of groups) {
    const show = week.shows[id];
    if (!show) {
      counts.missingDetails++;
      continue;
    }
    const seasonsAdded = [...new Set(seasons.map((c) => c.season!))].sort((a, b) => a - b);
    const kind: CandidateKind = titles.length
      ? show.showType === "movie"
        ? "movie"
        : "series"
      : seasonsAdded.includes(1)
        ? "series"
        : "newSeason";

    // On bulk re-listing days, drop that platform for titles older than last year.
    const year = show.showType === "movie" ? show.releaseYear : (show.lastAirYear ?? show.firstAirYear);
    const isRecent = year === undefined || year >= recentFrom;
    const platforms = platformsFor(show, titles, seasons).filter((p) => isRecent || !isBulk(p));
    if (!platforms.length) {
      counts.bulkRelistingExcluded++;
      continue;
    }

    candidates.push({
      id,
      tmdbId: show.tmdbId ?? null,
      title: show.title,
      kind,
      seasonsAdded,
      platforms,
      saDetails: {
        overview: show.overview?.trim() || null,
        genres: (show.genres ?? []).map((g) => g.name),
        runtime: show.runtime ?? null,
        episodeCount: show.episodeCount ?? null,
        seasonCount: show.seasonCount ?? null,
        year: show.releaseYear ?? show.firstAirYear ?? null,
      },
    });
  }

  counts.uniqueTitles = candidates.length;
  counts.movies = candidates.filter((c) => c.kind === "movie").length;
  counts.series = candidates.filter((c) => c.kind === "series").length;
  counts.newSeasons = candidates.filter((c) => c.kind === "newSeason").length;
  return { candidates, counts, bulkDays };
}

function platformsFor(show: SaShow, titles: SaChange[], seasons: SaChange[]): PlatformAvailability[] {
  const result: PlatformAvailability[] = [];
  for (const platform of SELECTED_PLATFORMS) {
    const titleChanges = titles.filter((c) => c.service.id === platform);
    const seasonChanges = seasons.filter((c) => c.service.id === platform).sort((a, b) => b.season! - a.season!);
    const all = [...titleChanges, ...seasonChanges];
    if (!all.length) continue;

    // Link order: the change itself (title first, then newest season), then the
    // show's own subscription option on the same platform. Never constructed.
    const showLink = show.streamingOptions?.in?.find((o) => o.service.id === platform && o.type === "subscription" && o.link)?.link;
    result.push({
      platform,
      name: PLATFORMS[platform].name,
      since: Math.max(...all.map((c) => c.timestamp!)),
      link: all.find((c) => c.link)?.link ?? showLink ?? null,
    });
  }
  return result;
}

export function istDay(unix: number): string {
  return new Date((unix + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

function findBulkDays(
  week: SaWeek,
  groups: Map<string, { titles: SaChange[]; seasons: SaChange[] }>,
  fromUnix: number,
  toUnix: number,
): BulkDay[] {
  const perDay = new Map<string, number>();
  for (const { titles, seasons } of groups.values())
    for (const c of [...titles, ...seasons]) {
      const k = `${c.service.id}|${istDay(c.timestamp!)}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }

  // Days we knowingly didn't fully read were too busy to read: also bulk days.
  const partly = new Set<string>();
  for (const gap of week.gaps ?? []) {
    for (let t = Math.max(gap.from, fromUnix); t <= Math.min(gap.to, toUnix); t += 3600)
      for (const p of gap.platforms) partly.add(`${p}|${istDay(t)}`);
    for (const p of gap.platforms) partly.add(`${p}|${istDay(Math.min(gap.to, toUnix))}`);
  }

  // Only days we actually saw changes from matter: unread days have no titles.
  const keys = new Set([...perDay].filter(([k, n]) => n >= BULK_DAY_THRESHOLD || partly.has(k)).map(([k]) => k));
  return [...keys].sort().map((k) => {
    const [platform, day] = k.split("|");
    return { platform: platform as PlatformId, day, changesSeen: perDay.get(k) ?? 0, partlyRead: partly.has(k) };
  });
}
