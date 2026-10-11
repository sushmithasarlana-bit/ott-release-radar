"use client";
// The interactive page: hero with this week's top pick, the two required
// buttons, filters, poster grid, Telegram preview and "behind the scenes".
// Talks only to our own API routes; no API keys ever reach the browser.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { GENRE_CHIPS, PLATFORMS, PREFS, SELECTED_PLATFORMS, UNKNOWN_GENRES, type PlatformId } from "@/lib/config";
import { formatDigest } from "@/lib/digest";
import type { DigestData, DigestTitle } from "@/lib/pipeline";
import type { FridayRecord } from "@/lib/service";
import styles from "./page.module.css";
import TitleCard, { LANGUAGE_NAMES, PlatformBadge, lengthLabel } from "./TitleCard";

interface Props {
  initialData: DigestData | null;
  lastFriday: FridayRecord | null;
  nextRun: number;
  cacheHours: number;
  info: { geminiModels: string[]; keepGenres: string[] };
  loadError?: string;
}

const istTime = (unix: number) =>
  `${new Date(unix * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} IST`;
const shortDate = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

const SOURCE_LABEL: Record<string, string> = { ok: "Worked", "saved-data": "Used saved data", failed: "Failed", skipped: "Not needed" };
const SOURCE_TONE: Record<string, string> = { ok: "good", "saved-data": "warn", failed: "bad", skipped: "neutral" };

// Our digest HTML only contains <b>, <i> and <a href="http(s)…"> built from escaped
// text (src/lib/digest.ts). Links open in a new tab here.
const forWeb = (html: string) => html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');

async function postJson(url: string, body: unknown) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    return json ?? { ok: false, error: `The server didn't answer properly (HTTP ${res.status}). Please try again.` };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your internet connection and try again." };
  }
}

/** Seconds since `startedAt` (ms), ticking once a second while it is set. */
function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

const STEPS = [
  { until: 4, label: "Checking what’s new on Netflix, Prime Video & JioHotstar" },
  { until: 8, label: "Looking up language, genre & synopsis on TMDB" },
  { until: Infinity, label: "Asking Gemini for watch-or-skip verdicts (~30 s)" },
];

type Verdict = "all" | "watch" | "skip";

export default function RadarClient({ initialData, lastFriday, nextRun, cacheHours, info, loadError }: Props) {
  const [data, setData] = useState<DigestData | null>(initialData);
  const [view, setView] = useState<"picks" | "telegram">("picks");
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewError, setPreviewError] = useState("");
  const [fromCache, setFromCache] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const seconds = useElapsed(startedAt);

  const [sendOpen, setSendOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [sendState, setSendState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [sendMessage, setSendMessage] = useState("");
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const sendSeconds = useElapsed(sendStartedAt);

  const [platform, setPlatform] = useState<"all" | PlatformId>("all");
  const [verdict, setVerdict] = useState<Verdict>("all");
  const [genres, setGenres] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);

  async function preview() {
    setPreviewState("loading");
    setPreviewError("");
    setStartedAt(Date.now());
    const res = await postJson("/api/preview", {});
    setStartedAt(null);
    if (res.ok) {
      setData(res.data);
      setFromCache(res.source === "cache");
      setPreviewState("idle");
      document.getElementById("picks")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      setPreviewError(res.error);
      setPreviewState("error");
    }
  }

  async function sendTest(e: React.FormEvent) {
    e.preventDefault();
    setSendState("loading");
    setSendStartedAt(Date.now());
    const res = await postJson("/api/send-test", { password });
    setSendStartedAt(null);
    if (res.ok) {
      setSendState("done");
      setSendMessage(`Sent ${res.sentMessages} message${res.sentMessages === 1 ? "" : "s"} marked [TEST] to the Telegram channel.`);
      setPassword("");
    } else {
      setSendState("error");
      setSendMessage(res.error);
    }
  }

  const titles = useMemo(() => data?.titles ?? [], [data]);
  const matchesExceptPlatform = (t: DigestTitle) =>
    (verdict === "all" || (verdict === "watch" ? t.verdict.verdict === "WATCH" : t.verdict.verdict === "SKIP")) &&
    (genres.length === 0 || GENRE_CHIPS.filter((g) => genres.includes(g.label)).some((g) => g.tmdb.some((n) => t.genres.includes(n)))) &&
    (languages.length === 0 || (t.language !== null && languages.includes(t.language)));
  const visible = titles.filter((t) => matchesExceptPlatform(t) && (platform === "all" || t.platforms.some((p) => p.platform === platform)));
  const platformCount = (p: "all" | PlatformId) =>
    titles.filter((t) => matchesExceptPlatform(t) && (p === "all" || t.platforms.some((x) => x.platform === p))).length;
  const languagesPresent = PREFS.languages.filter((l) => titles.some((t) => t.language === l));
  const filtersOn = platform !== "all" || verdict !== "all" || genres.length > 0 || languages.length > 0;
  const clearFilters = () => {
    setPlatform("all");
    setVerdict("all");
    setGenres([]);
    setLanguages([]);
  };
  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const top = titles.find((t) => t.verdict.verdict === "WATCH") ?? titles[0];
  const messages = useMemo(() => (data ? formatDigest(data, { test: false }) : []), [data]);
  const loading = previewState === "loading";

  return (
    <main className={styles.page}>
      {/* ------------------------------------------------------------ hero */}
      <section className={styles.hero} aria-labelledby="hero-title">
        {top?.backdrop && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.heroBackdrop} src={top.backdrop} alt="" aria-hidden="true" />
        )}
        <div className={styles.heroShade} aria-hidden="true" />
        <div className={styles.heroInner}>
          <p className={styles.eyebrow}>
            OTT Release Radar · {PREFS.viewerName}’s weekly concierge
            {data && ` · ${shortDate(data.window.from)} – ${shortDate(data.window.to)}`}
          </p>

          {top ? (
            <>
              <p className={styles.heroKicker}>This week’s top pick</p>
              <h1 id="hero-title" className={styles.heroTitle}>
                {top.title}
              </h1>
              <div className={styles.heroMeta}>
                {top.platforms.map((p) => (
                  <PlatformBadge key={p.platform} platform={p.platform} name={p.name} />
                ))}
                <span>{[top.kind === "movie" ? "Movie" : "Series", lengthLabel(top), top.language ? LANGUAGE_NAMES[top.language] : null].filter(Boolean).join(" · ")}</span>
                {top.verdict.verdict && (
                  <span className={styles.heroScore}>
                    {top.verdict.verdict} {top.verdict.score}/10
                  </span>
                )}
              </div>
              {top.verdict.reason && <p className={styles.heroReason}>“{top.verdict.reason}”</p>}
            </>
          ) : (
            <>
              <h1 id="hero-title" className={styles.heroTitle}>
                What’s new to stream this week
              </h1>
              <p className={styles.heroReason}>
                New arrivals on {SELECTED_PLATFORMS.map((p) => PLATFORMS[p].name).join(", ")}, picked for {PREFS.viewerName}’s taste.
              </p>
            </>
          )}

          {data && (
            <dl className={styles.stats}>
              <div>
                <dt>New this week</dt>
                <dd>{data.funnel.newTitles}</dd>
              </div>
              <div>
                <dt>Match the taste</dt>
                <dd>{data.funnel.inGenre}</dd>
              </div>
              <div className={styles.statWatch}>
                <dt>Worth watching</dt>
                <dd>{data.funnel.watch}</dd>
              </div>
            </dl>
          )}

          <div className={styles.heroActions}>
            <button className={styles.btnPrimary} onClick={preview} disabled={loading}>
              {loading ? "Building preview…" : "Preview this week’s digest"}
            </button>
            <button className={styles.btnGhost} onClick={() => setSendOpen((o) => !o)} aria-expanded={sendOpen} aria-controls="send-panel">
              Send test digest to Telegram
            </button>
          </div>
          <p className={styles.heroNote}>
            {data
              ? `Last refreshed at ${istTime(data.generatedAt)}${fromCache ? ` · results are reused for ${cacheHours} h to save free API limits` : " · just now"}`
              : "No run yet: the preview runs the full live pipeline (about 40 seconds). Nothing is sent."}
          </p>

          {loading && (
            <ol className={styles.progress} role="status" aria-live="polite">
              {STEPS.map((s, i) => {
                const prev = i === 0 ? 0 : STEPS[i - 1].until;
                const state = seconds >= s.until ? "done" : seconds >= prev ? "active" : "todo";
                return (
                  <li key={s.label} className={styles[`step_${state}`]}>
                    <span className={styles.stepDot} aria-hidden="true" />
                    {s.label}
                    {state === "active" && <span className={styles.muted}> · {seconds}s</span>}
                  </li>
                );
              })}
            </ol>
          )}
          {previewState === "error" && (
            <p className={styles.alertError} role="alert">
              {previewError}
            </p>
          )}
          {loadError && (
            <p className={styles.alertError} role="alert">
              {loadError}
            </p>
          )}

          {sendOpen && (
            <form id="send-panel" className={styles.sendPanel} onSubmit={sendTest}>
              <label htmlFor="demo-password">Demo password</label>
              <div className={styles.sendRow}>
                <input
                  id="demo-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password from the project owner"
                />
                <button type="submit" className={styles.btnPrimary} disabled={sendState === "loading" || !password}>
                  {sendState === "loading" ? `Sending… ${sendSeconds}s` : "Send [TEST]"}
                </button>
              </div>
              <p className={styles.muted}>Posts this week’s digest to the Telegram channel, marked “[TEST]”. Test sends never count as the Friday digest.</p>
              {sendState === "done" && (
                <p className={styles.alertOk} role="status">
                  {sendMessage}
                </p>
              )}
              {sendState === "error" && (
                <p className={styles.alertError} role="alert">
                  {sendMessage}
                </p>
              )}
            </form>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------ picks */}
      <section id="picks" className={styles.content} aria-label="This week's titles">
        <div className={styles.viewTabs} role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "picks"} onClick={() => setView("picks")}>
            Curated picks
          </button>
          <button role="tab" aria-selected={view === "telegram"} onClick={() => setView("telegram")}>
            Telegram preview
          </button>
        </div>

        {!data && !loading && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No picks yet</p>
            <p className={styles.muted}>Press “Preview this week’s digest” above to run the live pipeline.</p>
          </div>
        )}
        {!data && loading && (
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className={styles.skeleton} style={{ "--i": i } as CSSProperties} />
            ))}
          </div>
        )}

        {data && view === "picks" && (
          <>
            <div className={styles.filters}>
              <div className={styles.platformTabs} role="group" aria-label="Platform">
                {(["all", ...SELECTED_PLATFORMS] as const).map((p) => (
                  <button key={p} aria-pressed={platform === p} onClick={() => setPlatform(p)}>
                    {p === "all" ? "All platforms" : PLATFORMS[p].name}
                    <span className={styles.count}>{platformCount(p)}</span>
                  </button>
                ))}
              </div>
              <div className={styles.filterRow}>
                <div className={styles.segmented} role="group" aria-label="Verdict">
                  {(["all", "watch", "skip"] as const).map((v) => (
                    <button key={v} aria-pressed={verdict === v} onClick={() => setVerdict(v)} data-tone={v}>
                      {v === "all" ? "All" : v === "watch" ? "✓ Watch" : "✕ Skip"}
                    </button>
                  ))}
                </div>
                <div className={styles.chips} role="group" aria-label="Genre">
                  {GENRE_CHIPS.map((g) => (
                    <button key={g.label} aria-pressed={genres.includes(g.label)} onClick={() => toggle(genres, setGenres, g.label)}>
                      {g.label}
                    </button>
                  ))}
                </div>
                <div className={styles.chips} role="group" aria-label="Language">
                  {languagesPresent.map((l) => (
                    <button key={l} aria-pressed={languages.includes(l)} onClick={() => toggle(languages, setLanguages, l)}>
                      {LANGUAGE_NAMES[l] ?? l}
                    </button>
                  ))}
                </div>
                {filtersOn && (
                  <button className={styles.clear} onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </div>
              <p className={styles.resultCount} aria-live="polite">
                {visible.length} of {titles.length} titles
              </p>
            </div>

            {data.limitedData && (
              <p className={styles.alertWarn}>Limited data this week: Streaming Availability was down, so availability dates couldn’t be verified.</p>
            )}

            {visible.length ? (
              <div className={styles.grid}>
                {visible.map((t, i) => (
                  <TitleCard key={t.id} t={t} index={i} limitedData={data.limitedData} />
                ))}
              </div>
            ) : (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>{titles.length ? "Nothing matches these filters" : "Quiet week"}</p>
                <p className={styles.muted}>
                  {titles.length
                    ? "Try another platform or clear the filters."
                    : `None of the ${data.funnel.newTitles} new titles checked matched ${PREFS.viewerName}’s taste.`}
                </p>
                {filtersOn && (
                  <button className={styles.btnGhost} onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {data && view === "telegram" && (
          <div className={styles.telegram}>
            <p className={styles.muted}>Exactly what the Friday digest posts to Telegram ({messages.length} message{messages.length === 1 ? "" : "s"}).</p>
            <div className={styles.chat} aria-label="Digest as it appears in Telegram">
              {messages.map((m, i) => (
                <div key={i} className={styles.bubble} dangerouslySetInnerHTML={{ __html: forWeb(m) }} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ behind the scenes */}
      <section className={styles.content} aria-labelledby="bts-title">
        <h2 id="bts-title" className={styles.sectionTitle}>
          Behind the scenes
        </h2>
        <div className={styles.panels}>
          <div className={styles.panel}>
            <h3>Last run</h3>
            {data ? <RunSummary data={data} /> : <p className={styles.muted}>No run yet.</p>}
          </div>

          <div className={styles.panel}>
            <h3>Schedule</h3>
            <p className={styles.bigLine}>{istTime(nextRun)}</p>
            <p className={styles.muted}>
              Next digest · every Friday around 6 pm IST. Vercel’s free plan starts it within the hour (5:30–6:29 pm). A Saturday 9 am backup
              run sends only if Friday’s didn’t go out, so it is never sent twice.
            </p>
            <p className={styles.muted}>
              {lastFriday
                ? `Last Friday digest (week of ${lastFriday.week}): ${lastFriday.status}${lastFriday.messages ? `, ${lastFriday.messages} messages` : ""} at ${istTime(lastFriday.at)}${lastFriday.error ? ` (${lastFriday.error})` : ""}.`
                : "No scheduled Friday digest has been sent yet."}
            </p>
          </div>

          <div className={styles.panel}>
            <h3>{PREFS.viewerName}’s preferences</h3>
            <dl className={styles.prefs}>
              <dt>Genres</dt>
              <dd>{PREFS.genres.join(", ")}</dd>
              <dt>Languages</dt>
              <dd>{PREFS.languages.map((l) => LANGUAGE_NAMES[l] ?? l).join(", ")}</dd>
              <dt>Platforms</dt>
              <dd>
                {SELECTED_PLATFORMS.map((p) => PLATFORMS[p].name).join(", ")} · {PREFS.region === "IN" ? "India" : PREFS.region}
              </dd>
            </dl>
            <p className={styles.muted}>
              From <code>config/preferences.json</code>. Genre filter keeps: {info.keepGenres.join(", ")}.
            </p>
            {UNKNOWN_GENRES.length > 0 && (
              <p className={styles.alertWarn}>Not a recognised genre (ignored): {UNKNOWN_GENRES.join(", ")}. Check the spelling in preferences.json.</p>
            )}
          </div>

          <div className={`${styles.panel} ${styles.panelWide}`}>
            <h3>How this works</h3>
            <ol className={styles.how}>
              <li>
                <b>What’s new.</b> Streaming Availability (RapidAPI) lists titles and seasons added in India in the last 7 days, with the date
                added and the platform link. Fetches are saved, so each refresh only asks for what changed.
              </li>
              <li>
                <b>What is it.</b> TMDB adds original language, genres, runtime or episodes, synopsis and poster.
              </li>
              <li>
                <b>Filter.</b> Strictly Hindi, English or Tamil; loosely thriller, crime, mystery, sci-fi or drama.
              </li>
              <li>
                <b>Verdict.</b> One Gemini Flash call ({info.geminiModels[0]}, backup {info.geminiModels[1]}) gives WATCH or SKIP, a score, a
                reason, and a 2-line synopsis written only from TMDB’s text.
              </li>
              <li>
                <b>Deliver.</b> A Vercel cron posts the digest to Telegram every Friday around 18:00 IST (with a Saturday backup), never twice
                in one week.
              </li>
            </ol>
            <p className={styles.muted}>
              “New” = the date a title became available on one of these platforms in India, not its cinema or global release. If Streaming
              Availability is down, TMDB’s list of recent releases is used and labelled “Limited data”. API keys never leave the server.
            </p>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        Data: Streaming Availability API · TMDB (this product uses the TMDB API but is not endorsed or certified by TMDB) · Verdicts: Google Gemini
      </footer>
    </main>
  );
}

function RunSummary({ data }: { data: DigestData }) {
  const f = data.funnel;
  const s = data.sources;
  const steps: [string, number][] = [
    ["changes", f.changes],
    ...(f.bulkRelistingExcluded ? ([["re-listings removed", -f.bulkRelistingExcluded]] as [string, number][]) : []),
    ["new titles", f.newTitles],
    ["right language", f.inLanguage],
    ["right genre", f.inGenre],
    ["watch", f.watch],
  ];
  const rows: [string, string, string][] = [
    [
      "Streaming Availability",
      s.streamingAvailability.status,
      [
        s.streamingAvailability.requests ? `${s.streamingAvailability.requests} requests` : "",
        s.streamingAvailability.quotaRemaining !== null ? `${s.streamingAvailability.quotaRemaining}/${s.streamingAvailability.quotaLimit ?? "?"} left this month` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    ["TMDB", s.tmdb.status, `${s.tmdb.fromTmdb} from TMDB${s.tmdb.fromFallback ? `, ${s.tmdb.fromFallback} from fallback` : ""}`],
    ["Gemini", s.gemini.status, s.gemini.model ? `${s.gemini.model}${s.gemini.usedBackup ? " (backup)" : ""}` : ""],
  ];
  return (
    <>
      <ol className={styles.funnel} aria-label="Filter steps">
        {steps.map(([label, n]) => (
          <li key={label}>
            <b>{n}</b> {label}
          </li>
        ))}
      </ol>
      <ul className={styles.sources}>
        {rows.map(([name, status, detail]) => (
          <li key={name}>
            <span className={styles.dot} data-tone={SOURCE_TONE[status]} aria-hidden="true" />
            <b>{name}</b> {SOURCE_LABEL[status]}
            {detail && <span className={styles.muted}> · {detail}</span>}
          </li>
        ))}
        <li>
          <span className={styles.dot} data-tone={data.limitedData ? "warn" : "good"} aria-hidden="true" />
          <b>Data</b> {data.limitedData ? "Limited (TMDB fallback)" : "Full (Streaming Availability)"}
        </li>
      </ul>
      <p className={styles.muted}>
        Time:{" "}
        {Object.entries(data.timingsMs)
          .map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)}s`)
          .join(" · ") || "—"}
      </p>
      {data.notes.length > 0 && (
        <ul className={styles.notes}>
          {data.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}
