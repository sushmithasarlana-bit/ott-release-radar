import preferences from "../../config/preferences.json";

// Platform IDs below were confirmed against the live APIs on 2026-10-12:
// Streaming Availability GET /countries/in and TMDB /watch/providers?watch_region=IN.
export const PLATFORMS = {
  netflix: { name: "Netflix", saCatalog: "netflix.subscription", tmdbProviderId: 8 },
  prime: { name: "Prime Video", saCatalog: "prime.subscription", tmdbProviderId: 119 },
  hotstar: { name: "JioHotstar", saCatalog: "hotstar.subscription", tmdbProviderId: 2336 },
} as const;

export type PlatformId = keyof typeof PLATFORMS;

export interface Preferences {
  viewerName: string;
  region: string;
  platforms: string[];
  languages: string[];
  genres: string[];
  lookbackDays: number;
}

export const PREFS: Preferences = preferences;

/** Short fingerprint of the preferences; a cached digest made with other preferences is not reused. */
export const PREFS_VERSION = JSON.stringify([PREFS.genres, PREFS.languages, PREFS.platforms, PREFS.lookbackDays, PREFS.viewerName]);

// Platforms chosen in config/preferences.json, matched by display name.
export const SELECTED_PLATFORMS: PlatformId[] = (Object.keys(PLATFORMS) as PlatformId[]).filter((id) =>
  PREFS.platforms.some((name) => name.toLowerCase() === PLATFORMS[id].name.toLowerCase()),
);

export function isSelectedPlatform(id: string): id is PlatformId {
  return (SELECTED_PLATFORMS as string[]).includes(id);
}

// ---------------------------------------------------------------- genres
// Words you can put in preferences.json "genres" -> TMDB genre names they keep.
// Covers every TMDB movie and TV genre (from /genre/movie/list and
// /genre/tv/list, checked 2026-10-12). A preference matches a word if it
// contains it, so "indie drama" matches "drama" and "romantic comedy" matches
// both "romantic" and "comedy".
export const GENRE_WORDS: Record<string, string[]> = {
  thriller: ["Thriller", "Crime", "Mystery"], // TMDB TV has no "Thriller"
  crime: ["Crime"],
  mystery: ["Mystery"],
  suspense: ["Thriller", "Mystery"],
  "sci-fi": ["Science Fiction", "Sci-Fi & Fantasy"],
  "science fiction": ["Science Fiction", "Sci-Fi & Fantasy"],
  fantasy: ["Fantasy", "Sci-Fi & Fantasy"],
  drama: ["Drama"],
  horror: ["Horror"],
  comedy: ["Comedy"],
  action: ["Action", "Action & Adventure"],
  adventure: ["Adventure", "Action & Adventure"],
  romance: ["Romance"],
  romantic: ["Romance"],
  animation: ["Animation"],
  anime: ["Animation"],
  documentary: ["Documentary"],
  family: ["Family", "Kids"],
  kids: ["Kids", "Family"],
  history: ["History"],
  historical: ["History"],
  war: ["War", "War & Politics"],
  politics: ["War & Politics"],
  music: ["Music"],
  musical: ["Music"],
  western: ["Western"],
  reality: ["Reality"],
  news: ["News"],
  talk: ["Talk"],
  soap: ["Soap"],
  "tv movie": ["TV Movie"],
};

const wordsIn = (preference: string) => Object.keys(GENRE_WORDS).filter((w) => preference.toLowerCase().includes(w));

/** TMDB genre names that pass the genre filter, built from preferences.json. */
export const KEEP_GENRES = new Set(PREFS.genres.flatMap((g) => wordsIn(g).flatMap((w) => GENRE_WORDS[w])));

/** Preferences that matched no known genre word (shown on the page so typos are noticed). */
export const UNKNOWN_GENRES = PREFS.genres.filter((g) => wordsIn(g).length === 0);

// Filter chips on the page: one per kept TMDB genre, with TV/movie twins merged.
const CHIP_LABEL: Record<string, string> = {
  "Science Fiction": "Sci-Fi",
  "Sci-Fi & Fantasy": "Sci-Fi",
  "Action & Adventure": "Action",
  "War & Politics": "War",
  Kids: "Family",
};
export const GENRE_CHIPS: { label: string; tmdb: string[] }[] = [...KEEP_GENRES].reduce<{ label: string; tmdb: string[] }[]>((chips, name) => {
  const label = CHIP_LABEL[name] ?? name;
  const chip = chips.find((c) => c.label === label);
  if (chip) chip.tmdb.push(name);
  else chips.push({ label, tmdb: [name] });
  return chips;
}, []);

/** Plain-language notes for Gemini, e.g. "thriller also covers Crime, Mystery". */
export const GENRE_NOTES = PREFS.genres
  .flatMap((g) => wordsIn(g).map((w) => ({ w, names: GENRE_WORDS[w].filter((n) => n.toLowerCase() !== w) })))
  .filter(({ names }) => names.length > 0)
  .map(({ w, names }) => `${w} also covers ${names.map((n) => `"${n}"`).join(", ")}`)
  .join("; ");
