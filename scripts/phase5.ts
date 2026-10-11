// Phase 5 check: run the full pipeline, format the digest, and (with --send)
// post it to Telegram marked [TEST]. Saves the run to .data/last-run.json.
// Run: npx tsx --env-file=.env.local scripts/phase5.ts [--send] [--reuse]
// --reuse formats the saved last run instead of calling the APIs again.
import { readFile, writeFile } from "node:fs/promises";
import { formatDigest } from "../src/lib/digest";
import { runPipeline, type DigestData } from "../src/lib/pipeline";
import { sendMessages } from "../src/lib/sources/telegram";
import { getStore } from "../src/lib/store";

async function main() {
  const started = Date.now();
  let data: DigestData;
  if (process.argv.includes("--reuse")) {
    data = JSON.parse(await readFile(".data/last-run.json", "utf8"));
    data.funnel.newTitles = data.funnel.newTitles - data.funnel.bulkRelistingExcluded; // saved before the count fix
  } else {
    data = await runPipeline(getStore(), { reserveQuota: false });
    await writeFile(".data/last-run.json", JSON.stringify(data, null, 2));
  }
  console.log(`Pipeline: ${((Date.now() - started) / 1000).toFixed(1)}s total, steps (ms): ${JSON.stringify(data.timingsMs)}`);
  console.log(`Sources: ${JSON.stringify(data.sources)}`);
  console.log(`Funnel: ${JSON.stringify(data.funnel)}`);
  for (const n of data.notes) console.log(`Note: ${n}`);

  const messages = formatDigest(data, { test: true });
  console.log(`\n${messages.length} message(s), lengths: ${messages.map((m) => m.length).join(", ")}\n`);
  console.log("=== Message 1, first 2 titles (raw HTML) ===");
  console.log(messages[0].split("\n\n").slice(0, 3).join("\n\n"));
  const newSeason = data.titles.find((t) => t.kind === "newSeason");
  if (newSeason) console.log(`\n=== A New Season entry ===\n${messages.join("\n\n").split("\n\n").find((b) => b.includes(newSeason.title.replace(/&/g, "&amp;")))}`);

  if (process.argv.includes("--send")) {
    const ids = await sendMessages(messages);
    console.log(`\n✅ Sent ${ids.length} message(s) to Telegram, ids ${ids.join(", ")}`);
  } else {
    console.log("\n(not sent; add --send to post to Telegram)");
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
