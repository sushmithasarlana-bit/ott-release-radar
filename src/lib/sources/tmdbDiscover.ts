// "Limited data" fallback, used only when Streaming Availability is down and no
// recent saved data exists: recent releases on our platforms, from TMDB.
// TMDB does not know WHEN a title arrived on a platform, so dates are unknown.
import type { Candidate, PlatformAvailability } from "../candidates";
import { PLATFORMS, PREFS, SELECTED_PLATFORMS } from "../config";
import { env } from "../env";
import { getJson } from "../http";

const BASE = "https://api.themoviedb.org/3";
const DAY = 24 * 3600;

interface DiscoverResult {
  results: { id: number; title?: string; name?: string; overview?: string; release_date?: string; first_air_date?: string }[];
}
interface ProvidersResult {
  results?: Record<string, { link?: string; flatrate?: { provider_id: number }[] }>;
}

const isoDate = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

export async function discoverRecentTitles(window: { from: number; to: number }): Promise<Candidate[]> {
  const init = { headers: { Authorization: `Bearer ${env("TMDB_TOKEN")}`, accept: "application/json" } };
  const common = new URLSearchParams({
    watch_region: "IN",
    with_watch_providers: SELECTED_PLATFORMS.map((p) => PLATFORMS[p].tmdbProviderId).join("|"),
    with_watch_monetization_types: "flatrate",
    with_original_language: PREFS.languages.join("|"),
  });
  // Movies released in the last 30 days; series with an episode airing this week.
  const movieParams = new URLSearchParams(common);
  movieParams.set("primary_release_date.gte", isoDate(window.to - 30 * DAY));
  movieParams.set("primary_release_date.lte", isoDate(window.to));
  movieParams.set("sort_by", "primary_release_date.desc");
  const tvParams = new URLSearchParams(common);
  tvParams.set("air_date.gte", isoDate(window.from));
  tvParams.set("air_date.lte", isoDate(window.to));
  tvParams.set("sort_by", "popularity.desc");

  const [movies, tv] = await Promise.all([
    getJson<DiscoverResult>("TMDB", `${BASE}/discover/movie?${movieParams}`, init),
    getJson<DiscoverResult>("TMDB", `${BASE}/discover/tv?${tvParams}`, init),
  ]);
  const found = [
    ...movies.data.results.map((r) => ({ ...r, type: "movie" as const })),
    ...tv.data.results.map((r) => ({ ...r, type: "tv" as const })),
  ];

  // Which of our platforms each title is on, with TMDB's own "where to watch" link.
  const candidates = await Promise.all(
    found.map(async (r): Promise<Candidate | null> => {
      const tmdbId = `${r.type}/${r.id}`;
      const providers = await getJson<ProvidersResult>("TMDB", `${BASE}/${tmdbId}/watch/providers`, init).catch(() => null);
      const india = providers?.data.results?.IN;
      const ids = new Set((india?.flatrate ?? []).map((p) => p.provider_id));
      const platforms: PlatformAvailability[] = SELECTED_PLATFORMS.filter((p) => ids.has(PLATFORMS[p].tmdbProviderId)).map((p) => ({
        platform: p,
        name: PLATFORMS[p].name,
        since: 0, // unknown
        link: india?.link ?? null,
      }));
      if (!platforms.length) return null;
      const year = Number((r.release_date ?? r.first_air_date ?? "").slice(0, 4)) || null;
      return {
        id: `tmdb:${tmdbId}`,
        tmdbId,
        title: r.title ?? r.name ?? "Untitled",
        kind: r.type === "movie" ? "movie" : "series",
        seasonsAdded: [],
        platforms,
        saDetails: { overview: r.overview?.trim() || null, genres: [], runtime: null, episodeCount: null, seasonCount: null, year },
      };
    }),
  );
  return candidates.filter((c): c is Candidate => c !== null);
}
