// Pre-push safety check: makes sure no secret value from .env.local appears in
// any file git would upload. Prints file names only, never the values.
// Usage: node --env-file=.env.local scripts/check-secrets.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NAMES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TMDB_TOKEN", "RAPIDAPI_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "CRON_SECRET", "DEMO_PASSWORD", "VERCEL_OIDC_TOKEN", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"];
const secrets = NAMES.map((name) => [name, process.env[name] ?? ""]).filter(([, v]) => v.length >= 6);

const ignored = execSync("git check-ignore .env.local || true", { encoding: "utf8" }).trim();
if (ignored !== ".env.local") {
  console.error("❌ .env.local is NOT ignored by git. Do not push.");
  process.exit(1);
}
console.log("✅ .env.local is ignored by git");

const files = execSync("git ls-files --others --cached --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean);
let leaks = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [name, value] of secrets) {
    if (text.includes(value)) {
      console.error(`❌ ${name} value found in ${file}`);
      leaks++;
    }
  }
}
console.log(`Scanned ${files.length} uploadable files for ${secrets.length} secret values.`);
if (leaks) {
  console.error(`❌ ${leaks} leak(s) found. Do not push until fixed.`);
  process.exit(1);
}
console.log("✅ No secrets found in any file that would be uploaded.");
