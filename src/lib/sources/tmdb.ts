// TMDB: "what is this title" (language, genres, runtime, synopsis, episodes).
import { env } from "../env";
import { ApiError, getJson } from "../http";

const BASE = "https://api.themoviedb.org/3";
// From GET /configuration (images.secure_base_url), verified live on 2026-10-12.
const IMAGE_BASE = "https://image.tmdb.org/t/p/";

export interface TmdbDetails {
  tmdbId: string; // "movie/123" or "tv/456"
  originalLanguage: string;
  genres: string[];
  overview: string | null;
  runtime: number | null; // movies, minutes
  episodesBySeason: Record<number, number>; // series
  lastAirYear: number | null;
  year: number | null; // movie release year / series first-air year
  posterPath: string | null;
  backdropPath: string | null;
}

interface TmdbRaw {
  original_language: string;
  genres?: { id: number; name: string }[];
  overview?: string;
  runtime?: number | null;
  seasons?: { season_number: number; episode_count: number }[];
  last_air_date?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

/** Movie or TV details for a tmdbId like "movie/123". */
export async function getTmdbDetails(tmdbId: string): Promise<TmdbDetails> {
  if (!/^(movie|tv)\/\d+$/.test(tmdbId)) throw new ApiError("TMDB", null, `unexpected id "${tmdbId}"`);
  const init = { headers: { Authorization: `Bearer ${env("TMDB_TOKEN")}`, accept: "application/json" } };
  const url = `${BASE}/${tmdbId}?language=en-US`;

  // Connections to TMDB sometimes drop for a few seconds (seen during setup), so
  // network errors, rate limits and server errors get up to 3 retries.
  let raw: TmdbRaw | null = null;
  for (let attempt = 0; raw === null; attempt++) {
    try {
      raw = (await getJson<TmdbRaw>("TMDB", url, init, 10_000)).data;
    } catch (err) {
      const retryable = err instanceof ApiError && (err.status === null || err.status === 429 || err.status >= 500);
      if (!retryable || attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  return {
    tmdbId,
    originalLanguage: raw.original_language,
    genres: (raw.genres ?? []).map((g) => g.name),
    overview: raw.overview?.trim() || null,
    runtime: raw.runtime || null,
    episodesBySeason: Object.fromEntries((raw.seasons ?? []).map((s) => [s.season_number, s.episode_count])),
    lastAirYear: raw.last_air_date ? Number(raw.last_air_date.slice(0, 4)) : null,
    year: Number((raw.release_date || raw.first_air_date || "").slice(0, 4)) || null,
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
  };
}

/** Public TMDB page for a title: the agreed fallback when no platform link exists. */
export function tmdbPageUrl(tmdbId: string): string {
  return `https://www.themoviedb.org/${tmdbId}`;
}

/** TMDB image URL for a path TMDB returned (e.g. poster_path), at a TMDB-listed size. */
export function tmdbImageUrl(path: string | null, size: "w342" | "w780" | "w1280"): string | null {
  return path && /^\/[\w.-]+$/.test(path) ? `${IMAGE_BASE}${size}${path}` : null;
}
