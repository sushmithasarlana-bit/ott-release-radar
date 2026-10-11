// Formats DigestData as Telegram HTML messages (also rendered on the web page).
import { PREFS } from "./config";
import type { DigestData, DigestTitle } from "./pipeline";

// Telegram allows 4096 characters per message. We measure the raw HTML (tags
// and link URLs included), which is always longer than what Telegram counts.
// 20 characters are kept free for the "(2/3)" counter added after splitting.
const MAX_MESSAGE = 4000 - 20;

const LANGUAGE_NAMES: Record<string, string> = { hi: "Hindi", en: "English", ta: "Tamil" };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const shortDate = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const longDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

// Only http(s) links are ever emitted, so a bad link from an API can't become script.
const link = (url: string | null, text: string) =>
  url && /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text);

function lengthText(t: DigestTitle): string {
  if (t.kind === "movie") {
    if (!t.runtime) return "Runtime unknown";
    const h = Math.floor(t.runtime / 60);
    return h ? `${h}h ${t.runtime % 60}m` : `${t.runtime}m`;
  }
  const s = t.seasonsAdded;
  const seasons = s.length > 1 ? `Seasons ${s[0]}–${s.at(-1)}` : s.length ? `Season ${s[0]}` : "Series";
  if (t.episodes === null) return seasons;
  return `${seasons} · ${t.episodes} episode${t.episodes === 1 ? "" : "s"}${t.episodesScope === "series" ? " (whole series)" : ""}`;
}

export function formatTitle(t: DigestTitle): string {
  // The title already links to the first platform; link names only when there are several.
  const platforms = t.platforms.map((p) => (t.platforms.length > 1 ? link(p.link, p.name) : escapeHtml(p.name))).join(" + ");
  const kind = t.kind === "movie" ? "Movie" : "Series";
  const badge = t.kind === "newSeason" ? " · 📺 New Season" : "";
  // since = 0 means unknown (TMDB "limited data" fallback).
  const since = t.platforms.map((p) => (p.since ? `${escapeHtml(p.name)} since ${shortDate(p.since)}` : escapeHtml(p.name))).join(", ");
  const language = t.language ? (LANGUAGE_NAMES[t.language] ?? t.language) : "Language unknown";
  const v = t.verdict;
  const verdict = v.verdict
    ? `${v.verdict === "WATCH" ? "✅ WATCH" : "❌ SKIP"} — ${escapeHtml(v.reason ?? "")} (${v.score}/10)`
    : "🤖 AI verdict unavailable";

  return [
    `<b>${link(t.link, t.title)}</b> · ${platforms} · ${kind}${badge}`,
    `On ${since} · ${language} · ${lengthText(t)}`,
    `Genre: ${escapeHtml(t.genres.join(", ") || "unknown")}`,
    `<i>${escapeHtml(v.synopsis)}</i>`,
    verdict,
  ].join("\n");
}

/** SKIP titles get one line each, so the digest stays short. */
export function formatSkipLine(t: DigestTitle): string {
  const platforms = t.platforms.map((p) => escapeHtml(p.name)).join(" + ");
  const kind = t.kind === "movie" ? "Movie" : t.kind === "newSeason" ? "📺 New Season" : "Series";
  return `❌ ${link(t.link, t.title)} · ${platforms} · ${kind} — ${escapeHtml(t.verdict.reason ?? "")} (${t.verdict.score}/10)`;
}

export function formatHeader(data: DigestData, test: boolean): string {
  const range = `${shortDate(data.window.from)} – ${longDate(data.window.to)}`;
  const lines = [`${test ? "[TEST] " : ""}🆕 <b>NEW THIS WEEK</b> · ${range}`];
  if (data.limitedData) lines.push("⚠️ <b>Limited data this week</b> (availability dates unknown)");
  const f = data.funnel;
  lines.push(`<i>${f.newTitles} new titles checked → ${f.inLanguage} in Hindi/English/Tamil → ${f.inGenre} matched · ${f.watch} to watch</i>`);
  return lines.join("\n");
}

/** Full digest as one or more Telegram messages (split only between titles). */
export function formatDigest(data: DigestData, opts: { test: boolean }): string[] {
  const header = formatHeader(data, opts.test);
  if (data.titles.length === 0) {
    return [
      `${opts.test ? "[TEST] " : ""}🆕 <b>NEW THIS WEEK</b> · ${shortDate(data.window.from)} – ${longDate(data.window.to)}\n` +
        `😴 Quiet week: none of the ${data.funnel.newTitles} new titles checked matched ${escapeHtml(PREFS.viewerName)}'s taste.`,
    ];
  }

  // Full entries for WATCH (and titles without an AI verdict); one line per SKIP.
  // Each piece says what separates it from the previous one, so skip lines can
  // fill up the space left in a message.
  const pieces: { text: string; sep: string }[] = data.titles
    .filter((t) => t.verdict.verdict !== "SKIP")
    .map((t) => ({ text: formatTitle(t), sep: "\n\n" }));
  const skips = data.titles.filter((t) => t.verdict.verdict === "SKIP");
  if (skips.length) {
    pieces.push({ text: `<b>Skipped (${skips.length})</b>`, sep: "\n\n" });
    for (const t of skips) pieces.push({ text: formatSkipLine(t), sep: "\n" });
  }

  const messages: string[] = [];
  let current = header;
  for (const { text, sep } of pieces) {
    if (current.length + sep.length + text.length > MAX_MESSAGE) {
      messages.push(current);
      current = text;
    } else {
      current += sep + text;
    }
  }
  messages.push(current);
  if (messages.length > 1) return messages.map((m, i) => `${m}\n\n<i>(${i + 1}/${messages.length})</i>`);
  return messages;
}
