// Phase 3 check: take the saved week (no RapidAPI requests), add TMDB details,
// apply language + genre filters, and print the funnel and the kept titles.
// Run: npx tsx --env-file=.env.local scripts/phase3.ts
import { buildCandidates } from "../src/lib/candidates";
import { loadChangeLog } from "../src/lib/changeLog";
import { PREFS } from "../src/lib/config";
import { enrichAndFilter, KEEP_GENRES } from "../src/lib/enrich";
import { getStore } from "../src/lib/store";

const ist = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" });

async function main() {
  const store = getStore();
  const log = await loadChangeLog(store);
  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - PREFS.lookbackDays * 24 * 3600;
  const { candidates, counts: fetchCounts } = buildCandidates(log, fromUnix, toUnix);

  const started = Date.now();
  const { all, kept, counts } = await enrichAndFilter(candidates, store);
  console.log(`TMDB step: ${((Date.now() - started) / 1000).toFixed(1)}s for ${candidates.length} titles`);
  console.log(`Details from TMDB: ${counts.tmdbDetails}, from Streaming Availability fallback: ${counts.fallbackDetails}`);
  for (const e of counts.tmdbErrors) console.log(`  TMDB error: ${e}`);
  console.log(`Genres kept: ${[...KEEP_GENRES].join(", ")}\n`);

  console.log("FUNNEL");
  console.log(`  ${fetchCounts.titleChanges + fetchCounts.seasonChanges} changes -> ${fetchCounts.uniqueTitles} new titles`);
  console.log(`  -> ${counts.inLanguage} in Hindi/English/Tamil (${counts.languageUnknown} language unknown)`);
  console.log(`  -> ${counts.inGenre} after genre filter\n`);

  const langs: Record<string, number> = {};
  for (const t of all) langs[t.details.originalLanguage ?? "unknown"] = (langs[t.details.originalLanguage ?? "unknown"] ?? 0) + 1;
  console.log(`Original languages of all ${all.length}: ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const droppedGenre = all.filter((t) => PREFS.languages.includes(t.details.originalLanguage ?? "") && !kept.includes(t));
  console.log(`Dropped by genre (right language): ${droppedGenre.map((t) => `${t.title} [${t.details.genres.join("/") || "no genres"}]`).join("; ")}\n`);

  console.log(`KEPT (${kept.length}):`);
  for (const t of kept) {
    const d = t.details;
    const kind = t.kind === "movie" ? "Movie" : t.kind === "newSeason" ? "📺 New Season" : "Series";
    const s = t.seasonsAdded;
    const length =
      t.kind === "movie"
        ? d.runtime ? `${d.runtime} min` : "runtime ?"
        : `Season${s.length > 1 ? `s ${s[0]}-${s.at(-1)}` : ` ${s[0] ?? "?"}`}${d.episodes ? ` · ${d.episodes} episodes${d.episodesScope === "series" ? " (whole series)" : ""}` : ""}`;
    const where = t.platforms.map((p) => `${p.name} since ${ist(p.since)}`).join(" + ");
    console.log(`  ${t.title} · ${kind} · ${where} · ${d.originalLanguage} · ${length}`);
    console.log(`     Genre: ${d.genres.join(", ")} | synopsis: ${d.overview ? `${d.overview.length} chars` : "MISSING"} | source: ${d.source}`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
