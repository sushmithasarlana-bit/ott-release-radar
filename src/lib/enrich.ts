// Adds TMDB details to each candidate (falling back to Streaming Availability's
// own data), then applies the language and genre filters, counting each step.
import type { Candidate } from "./candidates";
import { KEEP_GENRES, PREFS } from "./config";
import { ApiError } from "./http";
import { getTmdbDetails, tmdbImageUrl, tmdbPageUrl, type TmdbDetails } from "./sources/tmdb";
import type { Store } from "./store";

const TMDB_CACHE_SECONDS = 7 * 24 * 3600;
const TMDB_CONCURRENCY = 8;

// Genre filter: TMDB genre names built from preferences.json (see GENRE_WORDS in config.ts).
export { KEEP_GENRES };

export interface Details {
  source: "tmdb" | "streaming-availability";
  originalLanguage: string | null; // null when TMDB failed (SA has no language)
  genres: string[];
  overview: string | null;
  runtime: number | null;
  episodes: number | null;
  // season: the one season added; added: total of all seasons added this week;
  // series: whole series (Streaming Availability fallback only)
  episodesScope: "season" | "added" | "series" | null;
  fallbackLink: string | null; // TMDB page, used only if a platform has no link
  year: number | null;
  poster: string | null; // TMDB poster image URL
  backdrop: string | null; // TMDB wide image URL
}

export interface Enriched extends Candidate {
  details: Details;
}

export interface FilterCounts {
  tmdbDetails: number;
  fallbackDetails: number;
  tmdbErrors: string[]; // distinct error messages, for the status page
  inLanguage: number;
  languageUnknown: number;
  inGenre: number;
}

export async function enrichAndFilter(candidates: Candidate[], store: Store) {
  const counts: FilterCounts = { tmdbDetails: 0, fallbackDetails: 0, tmdbErrors: [], inLanguage: 0, languageUnknown: 0, inGenre: 0 };
  const errors = new Set<string>();

  const enriched = await mapLimit(candidates, TMDB_CONCURRENCY, async (c): Promise<Enriched> => {
    let tmdb: TmdbDetails | null = null;
    if (c.tmdbId) {
      // v2: entries now include poster/backdrop/year.
      const cacheKey = `tmdb2-${c.tmdbId.replace("/", "-")}`;
      tmdb = await store.get<TmdbDetails>(cacheKey);
      if (!tmdb) {
        try {
          tmdb = await getTmdbDetails(c.tmdbId);
          await store.set(cacheKey, tmdb, TMDB_CACHE_SECONDS);
        } catch (err) {
          errors.add(err instanceof ApiError ? err.message : "TMDB: unexpected error");
        }
      }
    }
    if (tmdb) counts.tmdbDetails++;
    else counts.fallbackDetails++;
    return { ...c, details: tmdb ? fromTmdb(c, tmdb) : fromStreamingAvailability(c) };
  });
  counts.tmdbErrors = [...errors];

  const languages = new Set(PREFS.languages);
  const inLanguage = enriched.filter((t) => {
    if (t.details.originalLanguage === null) counts.languageUnknown++;
    return t.details.originalLanguage !== null && languages.has(t.details.originalLanguage);
  });
  counts.inLanguage = inLanguage.length;

  const kept = inLanguage.filter((t) => t.details.genres.some((g) => KEEP_GENRES.has(g)));
  counts.inGenre = kept.length;
  return { all: enriched, kept, counts };
}

function fromTmdb(c: Candidate, t: TmdbDetails): Details {
  const counts = c.seasonsAdded.map((n) => t.episodesBySeason[n]);
  const allKnown = counts.length > 0 && counts.every((n) => typeof n === "number");
  const episodes = allKnown ? counts.reduce((a, b) => a + b, 0) : null;
  return {
    source: "tmdb",
    originalLanguage: t.originalLanguage,
    genres: t.genres.length ? t.genres : c.saDetails.genres,
    overview: t.overview ?? c.saDetails.overview,
    runtime: c.kind === "movie" ? (t.runtime ?? c.saDetails.runtime) : null,
    episodes,
    episodesScope: episodes === null ? null : counts.length > 1 ? "added" : "season",
    fallbackLink: c.tmdbId ? tmdbPageUrl(c.tmdbId) : null,
    year: t.year ?? c.saDetails.year,
    poster: tmdbImageUrl(t.posterPath, "w342"),
    backdrop: tmdbImageUrl(t.backdropPath, "w1280"),
  };
}

function fromStreamingAvailability(c: Candidate): Details {
  const episodes = c.kind === "movie" ? null : c.saDetails.episodeCount;
  return {
    source: "streaming-availability",
    originalLanguage: null,
    genres: c.saDetails.genres,
    overview: c.saDetails.overview,
    runtime: c.kind === "movie" ? c.saDetails.runtime : null,
    episodes,
    episodesScope: episodes === null ? null : "series",
    fallbackLink: c.tmdbId ? tmdbPageUrl(c.tmdbId) : null,
    year: c.saDetails.year,
    poster: null,
    backdrop: null,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
