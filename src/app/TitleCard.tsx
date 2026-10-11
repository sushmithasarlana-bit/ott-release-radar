// One title as a poster card: platform badges, WATCH/SKIP, verified
// availability date, runtime or episodes, genres and a short synopsis.
import type { CSSProperties } from "react";
import type { DigestTitle } from "@/lib/pipeline";
import styles from "./page.module.css";

export const LANGUAGE_NAMES: Record<string, string> = { hi: "Hindi", en: "English", ta: "Tamil" };

// Brand colours as reported by Streaming Availability (GET /countries/in).
export const PLATFORM_COLORS: Record<string, string> = { netflix: "#E50914", prime: "#00A8E1", hotstar: "#000000" };

const date = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

export function lengthLabel(t: DigestTitle): string | null {
  if (t.kind === "movie") {
    if (!t.runtime) return null;
    const h = Math.floor(t.runtime / 60);
    return h ? `${h}h ${t.runtime % 60}m` : `${t.runtime}m`;
  }
  const s = t.seasonsAdded;
  const seasons = s.length > 1 ? `Seasons ${s[0]}–${s.at(-1)}` : s.length ? `Season ${s[0]}` : null;
  const eps = t.episodes !== null ? `${t.episodes} ep${t.episodes === 1 ? "" : "s"}${t.episodesScope === "series" ? " total" : ""}` : null;
  return [seasons, eps].filter(Boolean).join(" · ") || null;
}

export function PlatformBadge({ platform, name }: { platform: string; name: string }) {
  return (
    <span className={styles.platformBadge} style={{ "--brand": PLATFORM_COLORS[platform] ?? "#333" } as CSSProperties}>
      {name}
    </span>
  );
}

export default function TitleCard({ t, limitedData, index }: { t: DigestTitle; limitedData: boolean; index: number }) {
  const v = t.verdict.verdict;
  const verdictClass = v === "WATCH" ? styles.isWatch : v === "SKIP" ? styles.isSkip : styles.isUnknown;
  const watchLink = t.platforms.find((p) => p.link);
  const meta = [t.kind === "movie" ? "Movie" : "Series", lengthLabel(t), t.language ? (LANGUAGE_NAMES[t.language] ?? t.language) : null, t.year]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className={`${styles.card} ${verdictClass}`} style={{ "--i": Math.min(index, 12) } as CSSProperties}>
      <div className={styles.posterWrap}>
        {t.poster ? (
          // TMDB already serves this at the size we need (w342); no resizing service required.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.poster} src={t.poster} alt={`${t.title} poster`} loading="lazy" decoding="async" />
        ) : (
          <div className={styles.posterFallback} aria-hidden="true">
            {t.title.slice(0, 1)}
          </div>
        )}
        <div className={styles.posterShade} aria-hidden="true" />
        <div className={styles.posterTop}>
          {t.platforms.map((p) => (
            <PlatformBadge key={p.platform} platform={p.platform} name={p.name} />
          ))}
        </div>
        {t.kind === "newSeason" && <span className={styles.ribbon}>📺 New Season</span>}
        <div className={styles.verdictPill} aria-label={v ? `${v}, ${t.verdict.score} out of 10` : "AI verdict unavailable"}>
          {v ? (
            <>
              <span>{v === "WATCH" ? "✓ Watch" : "✕ Skip"}</span>
              <b>{t.verdict.score}</b>
            </>
          ) : (
            <span>AI n/a</span>
          )}
        </div>
      </div>

      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>
          {t.link && /^https?:\/\//.test(t.link) ? (
            <a href={t.link} target="_blank" rel="noopener noreferrer">
              {t.title}
            </a>
          ) : (
            t.title
          )}
        </h3>
        <p className={styles.meta}>{meta}</p>

        <p className={styles.availability}>
          {limitedData ? (
            <span title="TMDB knows the platform but not when the title arrived there.">
              ◌ On {t.platforms.map((p) => p.name).join(", ")} · date not verified
            </span>
          ) : (
            <span title="Date the title became available on this platform in India, from Streaming Availability.">
              <span className={styles.check} aria-hidden="true">
                ✓
              </span>{" "}
              {t.platforms.map((p) => `On ${p.name} since ${date(p.since)}`).join(" · ")}
            </span>
          )}
        </p>

        {t.genres.length > 0 && (
          <ul className={styles.genres} aria-label="Genres">
            {t.genres.slice(0, 4).map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        )}

        <p className={styles.synopsis}>{t.verdict.synopsis}</p>

        <p className={styles.reason}>
          {t.verdict.reason ? (
            <>
              <span className={styles.reasonLabel}>{v === "WATCH" ? "Why watch" : "Why skip"}</span> {t.verdict.reason}
            </>
          ) : (
            <span className={styles.reasonLabel}>AI verdict unavailable</span>
          )}
        </p>

        {watchLink?.link && (
          <a className={styles.watchLink} href={watchLink.link} target="_blank" rel="noopener noreferrer">
            Open on {watchLink.name} <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </article>
  );
}
