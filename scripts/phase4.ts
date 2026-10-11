// Phase 4 check: saved week -> TMDB (cached) -> filters -> one Gemini call.
// Also tests the fallbacks: broken primary model, and Gemini fully failing.
// Run: npx tsx --env-file=.env.local scripts/phase4.ts
import { buildCandidates } from "../src/lib/candidates";
import { loadChangeLog } from "../src/lib/changeLog";
import { PREFS } from "../src/lib/config";
import { enrichAndFilter } from "../src/lib/enrich";
import { GEMINI_MODELS, getVerdicts } from "../src/lib/sources/gemini";
import { getStore } from "../src/lib/store";

async function main() {
  const store = getStore();
  const toUnix = Math.floor(Date.now() / 1000);
  const { candidates } = buildCandidates(await loadChangeLog(store), toUnix - PREFS.lookbackDays * 86400, toUnix);
  const { kept } = await enrichAndFilter(candidates, store);

  const run = await getVerdicts(kept);
  const v = [...run.verdicts.values()];
  console.log(`Gemini: ${kept.length} titles in ONE call, ${(run.ms / 1000).toFixed(1)}s, answered by ${run.model}${run.usedBackup ? " (backup)" : ""}`);
  console.log(`Valid verdicts: ${v.filter((x) => x.verdict).length}/${kept.length}, WATCH ${v.filter((x) => x.verdict === "WATCH").length}, SKIP ${v.filter((x) => x.verdict === "SKIP").length}${run.error ? `, error: ${run.error}` : ""}\n`);

  const rows = kept
    .map((t) => ({ t, v: run.verdicts.get(t.id)! }))
    .sort((a, b) => Number(b.v.verdict === "WATCH") - Number(a.v.verdict === "WATCH") || (b.v.score ?? 0) - (a.v.score ?? 0));
  for (const { t, v } of rows) {
    console.log(`${v.verdict === "WATCH" ? "✅ WATCH" : "❌ SKIP "} ${String(v.score).padStart(2)}/10  ${t.title} (${t.details.originalLanguage}, ${t.details.genres.join("/")})`);
    console.log(`      reason:   ${v.reason}`);
    console.log(`      synopsis: ${v.synopsis}`);
    console.log(`      TMDB:     ${t.details.overview?.slice(0, 200)}`);
  }

  console.log("\n--- Fallback test 1: primary model broken -> backup should answer ---");
  const sample = kept.slice(0, 3);
  const backup = await getVerdicts(sample, ["gemini-does-not-exist", GEMINI_MODELS[1]]);
  console.log(`answered by ${backup.model}, usedBackup=${backup.usedBackup}, valid ${[...backup.verdicts.values()].filter((x) => x.verdict).length}/3`);

  console.log("--- Fallback test 2: both models broken -> digest still gets synopses ---");
  const none = await getVerdicts(sample, ["bad-model-1", "bad-model-2"]);
  console.log(`error: ${none.error}`);
  for (const t of sample) console.log(`  ${t.title}: verdict=${none.verdicts.get(t.id)!.verdict} synopsis="${none.verdicts.get(t.id)!.synopsis.slice(0, 60)}..."`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
