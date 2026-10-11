// Streaming Availability API (RapidAPI, Movie of the Night): "what's new, on
// which platform, since when, and where to tap".
import { PLATFORMS, isSelectedPlatform, type PlatformId } from "../config";
import { env } from "../env";
import { ApiError, getJson, type JsonResponse } from "../http";

const HOST = "streaming-availability.p.rapidapi.com";

export interface SaService {
  id: string;
  name: string;
}

export interface SaStreamingOption {
  service: SaService;
  type: string;
  link?: string;
  availableSince?: number;
}

export interface SaShow {
  id: string;
  showType: "movie" | "series";
  tmdbId?: string;
  title: string;
  overview?: string;
  releaseYear?: number;
  firstAirYear?: number;
  lastAirYear?: number;
  genres?: { id: string; name: string }[];
  runtime?: number;
  seasonCount?: number;
  episodeCount?: number;
  streamingOptions?: Record<string, SaStreamingOption[]>;
}

export interface SaChange {
  changeType: string;
  itemType: "show" | "season" | "episode";
  showId: string;
  showType: "movie" | "series";
  season?: number;
  service: SaService;
  streamingOptionType: string;
  timestamp?: number;
  link?: string;
}

interface SaChangesPage {
  changes: SaChange[];
  shows: Record<string, SaShow>;
  hasMore: boolean;
  nextCursor?: string;
}

export interface SaPages {
  changes: SaChange[];
  shows: Record<string, SaShow>;
  requests: number;
  /** True when we stopped at maxPages with older pages left unread. */
  capped: boolean;
  quotaRemaining: number | null;
  quotaLimit: number | null;
}

function headerNumber(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  return v === null ? null : Number(v);
}

/** "New" changes since fromUnix on the given platforms, NEWEST first, up to maxPages pages of 25. */
export async function fetchChangePages(
  itemType: "show" | "season",
  platforms: PlatformId[],
  fromUnix: number,
  maxPages: number,
): Promise<SaPages> {
  const key = env("RAPIDAPI_KEY");
  const out: SaPages = { changes: [], shows: {}, requests: 0, capped: false, quotaRemaining: null, quotaLimit: null };
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      country: "in",
      change_type: "new",
      item_type: itemType,
      catalogs: platforms.map((id) => PLATFORMS[id].saCatalog).join(","),
      from: String(fromUnix),
      order_direction: "desc",
    });
    if (cursor) params.set("cursor", cursor);
    const { data, headers } = await getWithRetry(`https://${HOST}/changes?${params}`, key);
    out.requests++;
    out.quotaRemaining = headerNumber(headers, "x-ratelimit-api-request-remaining");
    out.quotaLimit = headerNumber(headers, "x-ratelimit-api-request-limit");
    out.changes.push(...(data.changes ?? []).map(trimChange));
    for (const [id, show] of Object.entries(data.shows ?? {})) out.shows[id] = trimShow(show);
    cursor = data.hasMore && data.nextCursor ? data.nextCursor : null;
  } while (cursor && out.requests < maxPages);

  out.capped = cursor !== null;
  return out;
}

// From Vercel's shared servers, RapidAPI sometimes answers 429 "Too many requests"
// even though the monthly quota is fine (seen on the first deploy). Wait and retry.
async function getWithRetry(url: string, key: string): Promise<JsonResponse<SaChangesPage>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJson<SaChangesPage>("Streaming Availability", url, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": HOST } });
    } catch (err) {
      const retryable = err instanceof ApiError && (err.status === null || err.status === 429 || err.status >= 500);
      if (!retryable || attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); // 1.5 s, 3 s, 6 s
    }
  }
}

// Keep only the fields we use, so the saved week stays small.
function trimChange(c: SaChange): SaChange {
  return {
    changeType: c.changeType,
    itemType: c.itemType,
    showId: c.showId,
    showType: c.showType,
    season: c.season,
    service: { id: c.service.id, name: c.service.name },
    streamingOptionType: c.streamingOptionType,
    timestamp: c.timestamp,
    link: c.link,
  };
}

export function trimShow(s: SaShow): SaShow {
  const options = (s.streamingOptions?.in ?? [])
    .filter((o) => isSelectedPlatform(o.service.id) && o.type === "subscription")
    .map((o) => ({ service: { id: o.service.id, name: o.service.name }, type: o.type, link: o.link, availableSince: o.availableSince }));
  return {
    id: s.id,
    showType: s.showType,
    tmdbId: s.tmdbId,
    title: s.title,
    overview: s.overview,
    releaseYear: s.releaseYear,
    firstAirYear: s.firstAirYear,
    lastAirYear: s.lastAirYear,
    genres: s.genres?.map((g) => ({ id: g.id, name: g.name })),
    runtime: s.runtime,
    seasonCount: s.seasonCount,
    episodeCount: s.episodeCount,
    streamingOptions: { in: options },
  };
}
