// Phase 1 API smoke tests. Prints what each live API returns, never the keys.
// Usage: node --env-file=.env.local scripts/test-apis.mjs <step> [arg]
// Steps: env | telegram | tmdb | sa-countries | sa-changes <catalogs> |
//        tmdb-details | gemini-models | gemini-test <model>
import { mkdir, writeFile, readFile } from "node:fs/promises";

const SECRET_NAMES = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TMDB_TOKEN",
  "RAPIDAPI_KEY",
  "OPENROUTER_API_KEY",
  "CRON_SECRET",
  "DEMO_PASSWORD",
];

// Replace any secret value that sneaks into output with its name.
function scrub(text) {
  let out = String(text);
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join(`<${name}>`);
  }
  return out;
}
const log = (...parts) => console.log(scrub(parts.join(" ")));
const show = (obj) => log(JSON.stringify(obj, null, 2));

function need(name) {
  const value = process.env[name];
  if (!value) {
    log(`❌ ${name} is empty in .env.local. Fill it in and run again.`);
    process.exit(1);
  }
  return value;
}

async function saveSample(name, data) {
  await mkdir("samples", { recursive: true });
  await writeFile(`samples/${name}.json`, scrub(JSON.stringify(data, null, 2)));
  log(`   (full raw response saved to samples/${name}.json)`);
}

async function call(label, url, init = {}) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    throw new Error(`${label}: network error (${err.cause?.code ?? err.name ?? err.message})`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  return { status: res.status, ok: res.ok, headers: res.headers, body, ms: Date.now() - started };
}

function fail(label, r, hint) {
  log(`❌ ${label} failed: HTTP ${r.status} after ${r.ms} ms`);
  show(r.body);
  if (hint) log(`   Hint: ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------- env
function stepEnv() {
  const checks = {
    TELEGRAM_BOT_TOKEN: (v) =>
      /^\d+:[\w-]{30,}$/.test(v) ? "format looks right" : "expected 123456789:ABC... - double-check",
    TELEGRAM_CHAT_ID: (v) =>
      /^-100\d+$/.test(v)
        ? "format looks right (channel ID)"
        : /^-?\d+$/.test(v)
          ? "a number, but channel IDs usually start with -100"
          : "expected a number starting with -100",
    TMDB_TOKEN: (v) =>
      v.startsWith("eyJ")
        ? "looks like a Read Access Token"
        : /^[a-f0-9]{32}$/i.test(v)
          ? "this looks like the SHORT 'API Key' - we need the long 'API Read Access Token'"
          : "expected a long token starting with eyJ",
    RAPIDAPI_KEY: (v) => (v.length >= 40 ? "length looks right" : "seems short - double-check"),
    OPENROUTER_API_KEY: (v) => (v.startsWith("sk-or-") ? "format looks right" : "expected a key starting with sk-or-"),
    CRON_SECRET: (v) => (v.length >= 32 ? "generated" : "too short"),
    DEMO_PASSWORD: (v) => (v.length >= 8 ? "generated" : "too short"),
  };
  let missing = 0;
  log("Checking .env.local (values are never shown):");
  for (const [name, check] of Object.entries(checks)) {
    const v = process.env[name] ?? "";
    if (!v) {
      missing++;
      log(`  ⬜ ${name.padEnd(19)} EMPTY`);
      continue;
    }
    const warn = /^["']|["']$|\s/.test(v) ? "  ⚠️ contains quotes or spaces - remove them" : "";
    log(`  ✅ ${name.padEnd(19)} set (${v.length} chars) - ${check(v)}${warn}`);
  }
  log(missing ? `\n${missing} value(s) still empty.` : "\nAll values are filled in.");
}

// ---------------------------------------------------------------- telegram
async function stepTelegram() {
  const token = need("TELEGRAM_BOT_TOKEN");
  const chatId = need("TELEGRAM_CHAT_ID");
  const tg = (method, payload = {}) =>
    call(`Telegram ${method}`, `https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const me = await tg("getMe");
  if (!me.ok) fail("Telegram getMe", me, "the bot token is wrong. Copy it again from @BotFather.");
  log(`✅ Bot token works. Bot is @${me.body.result.username} (id ${me.body.result.id})`);

  const chat = await tg("getChat", { chat_id: chatId });
  if (!chat.ok)
    fail("Telegram getChat", chat, "the bot can't see this chat. Add the bot to your channel as an Administrator, and check the chat ID.");
  log(`✅ Chat found: type="${chat.body.result.type}", title="${chat.body.result.title}"`);

  const member = await tg("getChatMember", { chat_id: chatId, user_id: me.body.result.id });
  if (member.ok) {
    const m = member.body.result;
    log(`   Bot's role in the chat: ${m.status}${m.can_post_messages === false ? " (⚠️ cannot post messages)" : ""}`);
  }

  const sent = await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    text:
      "🔧 <b>OTT Release Radar - setup test</b>\n" +
      "If you can read this, the bot can post to this channel. ✅\n" +
      `<i>Sent ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</i>`,
  });
  if (!sent.ok) fail("Telegram sendMessage", sent, "make sure the bot is an Administrator with 'Post messages' permission.");
  log(`✅ Test message posted (message_id ${sent.body.result.message_id}). Check your channel!`);
}

// ---------------------------------------------------------------- tmdb
async function stepTmdb() {
  const token = need("TMDB_TOKEN");
  const tmdb = (path) =>
    call(`TMDB ${path}`, `https://api.themoviedb.org/3${path}`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    });

  const auth = await tmdb("/authentication");
  if (!auth.ok) fail("TMDB /authentication", auth, "use the long 'API Read Access Token' from themoviedb.org > Settings > API.");
  log(`✅ TMDB token works (${auth.ms} ms): success=${auth.body.success}`);

  for (const kind of ["movie", "tv"]) {
    const r = await tmdb(`/watch/providers/${kind}?watch_region=IN&language=en-US`);
    if (!r.ok) fail(`TMDB providers (${kind})`, r);
    const wanted = r.body.results.filter((p) => /netflix|prime|amazon|hotstar|jio/i.test(p.provider_name));
    log(`\nTMDB ${kind} providers in India matching Netflix/Prime/Hotstar/Jio (${r.body.results.length} total providers):`);
    for (const p of wanted) log(`   id ${String(p.provider_id).padEnd(6)} ${p.provider_name}`);
    await saveSample(`tmdb-providers-${kind}-IN`, r.body);
  }

  for (const kind of ["movie", "tv"]) {
    const r = await tmdb(`/genre/${kind}/list?language=en`);
    if (!r.ok) fail(`TMDB genres (${kind})`, r);
    log(`\nTMDB ${kind} genres: ${r.body.genres.map((g) => `${g.name}(${g.id})`).join(", ")}`);
  }
}

// ---------------------------------------------------------------- streaming availability
const SA_HOST = "streaming-availability.p.rapidapi.com";
function sa(path) {
  const key = need("RAPIDAPI_KEY");
  return call(`Streaming Availability ${path}`, `https://${SA_HOST}${path}`, {
    headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": SA_HOST },
  });
}
function logQuota(r) {
  const quota = [...r.headers.entries()].filter(([k]) => k.startsWith("x-ratelimit"));
  if (quota.length) log(`   RapidAPI quota headers: ${quota.map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

async function stepSaCountries() {
  const r = await sa("/countries/in");
  logQuota(r);
  if (!r.ok)
    fail("Streaming Availability /countries/in", r, "check RAPIDAPI_KEY and that you are subscribed (free plan) to the Streaming Availability API on RapidAPI.");
  log(`✅ /countries/in worked (${r.ms} ms). Top-level fields: ${Object.keys(r.body).join(", ")}`);
  log(`\nServices available in India (${r.body.services?.length ?? 0}):`);
  for (const s of r.body.services ?? []) {
    const types = Object.entries(s.streamingOptionTypes ?? {})
      .filter(([, on]) => on)
      .map(([t]) => t)
      .join("/");
    log(`   id="${s.id}"  name="${s.name}"  types=${types}  addons=${s.addons?.length ?? 0}`);
  }
  await saveSample("sa-countries-in", r.body);
}

async function stepSaChanges(catalogs) {
  if (!catalogs) {
    log("❌ Pass the catalogs to test, e.g. netflix,prime.subscription");
    process.exit(1);
  }
  const from = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  log(`Window: since ${new Date(from * 1000).toISOString()} (7 days ago). catalogs=${catalogs}`);
  for (const itemType of ["show", "season"]) {
    const params = new URLSearchParams({
      country: "in",
      change_type: "new",
      item_type: itemType,
      catalogs,
      from: String(from),
    });
    const r = await sa(`/changes?${params}`);
    logQuota(r);
    if (!r.ok) fail(`/changes item_type=${itemType}`, r);
    const { changes = [], shows = {}, hasMore, nextCursor } = r.body;
    log(`\n✅ /changes item_type=${itemType} (${r.ms} ms): fields = ${Object.keys(r.body).join(", ")}`);
    log(`   page 1: ${changes.length} changes, ${Object.keys(shows).length} shows, hasMore=${hasMore}, nextCursor=${nextCursor ?? "-"}`);
    if (changes[0]) {
      log("   First change object exactly as returned:");
      show(changes[0]);
    }
    log("   First 10 on this page:");
    for (const c of changes.slice(0, 10)) {
      const s = shows[c.showId] ?? {};
      const when = c.timestamp ? new Date(c.timestamp * 1000).toISOString().slice(0, 10) : "?";
      const season = c.season ? ` S${c.season.title ?? c.season}` : "";
      log(`   ${when}  ${(c.service?.name ?? c.service?.id ?? "?").padEnd(12)} ${c.showType?.padEnd(7) ?? ""} ${s.title ?? c.showId}${season}  tmdb=${s.tmdbId ?? "-"}  link=${c.link ? "yes" : "no"}`);
    }
    await saveSample(`sa-changes-${itemType}`, r.body);
  }
}

// ---------------------------------------------------------------- tmdb details (uses saved /changes samples)
async function stepTmdbDetails() {
  const token = need("TMDB_TOKEN");
  const picks = [];
  for (const itemType of ["show", "season"]) {
    try {
      const body = JSON.parse(await readFile(`samples/sa-changes-${itemType}.json`, "utf8"));
      for (const c of body.changes ?? []) {
        const s = body.shows?.[c.showId];
        if (s?.tmdbId && !picks.some((p) => p.tmdbId === s.tmdbId)) picks.push({ tmdbId: s.tmdbId, title: s.title, itemType });
        if (picks.filter((p) => p.itemType === itemType).length >= 2) break;
      }
    } catch {
      log(`(no samples/sa-changes-${itemType}.json yet - run sa-changes first)`);
    }
  }
  for (const p of picks) {
    const r = await call(`TMDB /${p.tmdbId}`, `https://api.themoviedb.org/3/${p.tmdbId}?language=en-US`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!r.ok) {
      log(`❌ TMDB ${p.tmdbId} (${p.title}): HTTP ${r.status}`);
      continue;
    }
    const d = r.body;
    log(`\n✅ TMDB ${p.tmdbId} "${d.title ?? d.name}" (${r.ms} ms)`);
    log(`   original_language=${d.original_language}  genres=${(d.genres ?? []).map((g) => g.name).join(", ")}`);
    if (d.runtime !== undefined) log(`   runtime=${d.runtime} min`);
    if (d.seasons) log(`   seasons: ${d.seasons.map((s) => `S${s.season_number}=${s.episode_count}ep`).join(", ")}`);
    log(`   overview: ${(d.overview || "(empty)").slice(0, 160)}${d.overview?.length > 160 ? "..." : ""}`);
    await saveSample(`tmdb-${p.tmdbId.replace("/", "-")}`, d);
  }
}

// ---------------------------------------------------------------- gemini
// Gemini is called through OpenRouter (openrouter.ai).
async function stepGeminiModels() {
  const key = need("OPENROUTER_API_KEY");
  const r = await call("OpenRouter models", "https://openrouter.ai/api/v1/models");
  if (!r.ok) fail("OpenRouter list models", r);
  const flash = (r.body.data ?? []).filter((m) => /^google\/gemini.*flash/i.test(m.id));
  log(`✅ OpenRouter lists ${flash.length} Gemini Flash models:`);
  for (const m of flash) log(`   ${m.id}`);
  const k = await call("OpenRouter key", "https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
  if (!k.ok) fail("OpenRouter key check", k, "check OPENROUTER_API_KEY (openrouter.ai > Keys).");
  log(`✅ Key works. Credit limit: ${k.body.data?.limit ?? "none"}, remaining: ${k.body.data?.limit_remaining ?? "?"}`);
}

async function stepGeminiTest(model) {
  const key = need("OPENROUTER_API_KEY");
  if (!model) {
    log("❌ Pass an OpenRouter model id, e.g. google/gemini-3.7-flash");
    process.exit(1);
  }
  const r = await call("OpenRouter chat", "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: 'Return JSON exactly like {"ok": true, "greeting": "<a five word greeting>"}' }],
      temperature: 0.2,
      reasoning: { effort: "low" },
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok || r.body.error) fail(`OpenRouter ${model}`, r);
  const choice = r.body.choices?.[0];
  const text = choice?.message?.content ?? "";
  log(`✅ ${model} answered in ${r.ms} ms (served by ${r.body.model} via ${r.body.provider}, finish_reason=${choice?.finish_reason})`);
  log(`   Raw text: ${text}`);
  try {
    log(`   Parsed JSON OK: ${JSON.stringify(JSON.parse(text))}`);
  } catch {
    log("   ⚠️ Response was not valid JSON");
  }
}

// ---------------------------------------------------------------- main
const [step, arg] = process.argv.slice(2);
const steps = {
  env: stepEnv,
  telegram: stepTelegram,
  tmdb: stepTmdb,
  "sa-countries": stepSaCountries,
  "sa-changes": () => stepSaChanges(arg),
  "tmdb-details": stepTmdbDetails,
  "gemini-models": stepGeminiModels,
  "gemini-test": () => stepGeminiTest(arg),
};
if (!steps[step]) {
  log(`Usage: node --env-file=.env.local scripts/test-apis.mjs <${Object.keys(steps).join(" | ")}>`);
  process.exit(1);
}
try {
  await steps[step]();
} catch (err) {
  log(`❌ ${err.message}`);
  process.exit(1);
}
