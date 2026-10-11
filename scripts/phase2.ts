// Phase 2 check: sync the saved week of Streaming Availability changes (only
// fetching what's new, newest first), group into titles, and print a report.
// Run: npx tsx --env-file=.env.local scripts/phase2.ts
import { stat } from "node:fs/promises";
import { buildCandidates, type Candidate } from "../src/lib/candidates";
import { syncChangeLog } from "../src/lib/changeLog";
import { PREFS } from "../src/lib/config";
import { getStore } from "../src/lib/store";

const ist = (unix: number) =>
  new Date(unix * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

async function main() {
  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - PREFS.lookbackDays * 24 * 3600;
  console.log(`Window: ${ist(fromUnix)} -> ${ist(toUnix)} IST`);

  const started = Date.now();
  const sync = await syncChangeLog(getStore(), toUnix);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const size = (await stat(".data/sa-changelog-v2.json")).size;
  console.log(`Sync: ${sync.requests} API requests in ${seconds}s, ${sync.added} new changes saved (${(size / 1024).toFixed(0)} KB on disk)`);
  console.log(`RapidAPI quota left this month: ${sync.quotaRemaining} of ${sync.quotaLimit}`);
  for (const g of sync.log.gaps) console.log(`Not read (too many): ${g.platforms.join("+")} ${g.itemType}s ${ist(g.from)} -> ${ist(g.to)}`);

  const { candidates, counts, bulkDays } = buildCandidates(sync.log, fromUnix, toUnix);
  for (const b of bulkDays) console.log(`Bulk re-listing day: ${b.platform} ${b.day} (${b.changesSeen} read${b.partlyRead ? ", more not read" : ""})`);
  console.log("\nCounts:");
  console.log(`  "new title" changes: ${counts.titleChanges}, "new season" changes: ${counts.seasonChanges}`);
  console.log(`  dropped: outside 7 days ${counts.outsideWindow}, other platform/type ${counts.otherPlatformOrType}, no details ${counts.missingDetails}`);
  console.log(`  dropped: old titles on bulk re-listing days ${counts.bulkRelistingExcluded}`);
  console.log(`  => unique titles: ${counts.uniqueTitles}  (movies ${counts.movies}, series ${counts.series}, new seasons ${counts.newSeasons})`);
  const perPlatform: Record<string, number> = {};
  for (const c of candidates) for (const p of c.platforms) perPlatform[p.name] = (perPlatform[p.name] ?? 0) + 1;
  console.log(`  per platform: ${Object.entries(perPlatform).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const multi = candidates.filter((c) => c.platforms.length > 1);
  console.log(`  merged (on 2+ platforms): ${multi.length}${multi.length ? " - " + multi.map((c) => c.title).join(", ") : ""}`);
  console.log(`  missing a platform link: ${candidates.filter((c) => c.platforms.some((p) => !p.link)).length}, missing tmdbId: ${candidates.filter((c) => !c.tmdbId).length}\n`);

  const describe = (c: Candidate) => {
    const s = c.seasonsAdded;
    const seasons = s.length ? ` [S${s.length > 1 ? `${s[0]}-${s.at(-1)}` : s[0]}]` : "";
    const where = c.platforms.map((p) => `${p.name} ${ist(p.since)}`).join(" + ");
    return `  ${c.title} (${c.saDetails.year ?? "?"})${seasons}  |  ${where}  |  ${c.tmdbId ?? "-"}`;
  };
  const newest = (a: Candidate, b: Candidate) => b.platforms[0].since - a.platforms[0].since;
  console.log(`--- 📺 New Season (${counts.newSeasons}) ---`);
  candidates.filter((c) => c.kind === "newSeason").sort(newest).forEach((c) => console.log(describe(c)));
  for (const platform of ["Netflix", "Prime Video", "JioHotstar"]) {
    const list = candidates.filter((c) => c.kind !== "newSeason" && c.platforms.some((p) => p.name === platform)).sort(newest);
    console.log(`--- New on ${platform} (${list.length}${list.length > 12 ? ", newest 12 shown" : ""}) ---`);
    list.slice(0, 12).forEach((c) => console.log(describe(c)));
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
