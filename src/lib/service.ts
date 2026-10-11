// What the buttons and the Friday cron do, on top of the pipeline: caching,
// one-run-at-a-time locking, rate limits, and the "send Friday only once" rule.
import { createHash, timingSafeEqual } from "node:crypto";
import { PREFS_VERSION } from "./config";
import { env } from "./env";
import { runPipeline, type DigestData } from "./pipeline";
import type { Store } from "./store";

const CACHE_KEY = "digest-cache";
const LOCK_KEY = "pipeline-lock";
const LAST_FRIDAY_KEY = "last-friday-digest";
// Repeated clicks within this time reuse the last run (saves RapidAPI + Gemini quota).
export const CACHE_FRESH_SECONDS = 6 * 3600;
const DEGRADED_FRESH_SECONDS = 30 * 60;
const LOCK_SECONDS = 280; // a little under Vercel's 300 s limit
const IST_OFFSET = 5.5 * 3600;

export type DigestSource = "cache" | "fresh" | "waited-for-other-run";

export async function getCachedDigest(store: Store): Promise<DigestData | null> {
  return store.get<DigestData>(CACHE_KEY);
}

/**
 * Returns the cached digest if it is fresh enough, otherwise runs the pipeline.
 * Only one run happens at a time: other callers wait for it and share the result.
 */
export async function getDigest(
  store: Store,
  opts: { maxAgeSeconds: number; reserveQuota: boolean },
): Promise<{ data: DigestData; source: DigestSource }> {
  const now = () => Math.floor(Date.now() / 1000);
  const cached = await getCachedDigest(store);
  // A run that had to fall back (limited data, no AI verdicts) is only reused briefly.
  const degraded = cached && (cached.limitedData || cached.sources.gemini.status === "failed");
  const maxAge = degraded ? Math.min(opts.maxAgeSeconds, DEGRADED_FRESH_SECONDS) : opts.maxAgeSeconds;
  const cacheUsable = cached && cached.prefsVersion === PREFS_VERSION && now() - cached.generatedAt < maxAge;
  if (cacheUsable) return { data: cached, source: "cache" };

  if (await store.setIfAbsent(LOCK_KEY, now(), LOCK_SECONDS)) {
    try {
      const data = await runPipeline(store, { reserveQuota: opts.reserveQuota });
      await store.set(CACHE_KEY, data, 9 * 24 * 3600);
      return { data, source: "fresh" };
    } finally {
      await store.del(LOCK_KEY);
    }
  }

  // Someone else is running it right now: wait for their result (up to ~4 min).
  const started = now();
  while (now() - started < 240) {
    await new Promise((r) => setTimeout(r, 2000));
    const latest = await getCachedDigest(store);
    if (latest && latest.generatedAt >= started - 5) return { data: latest, source: "waited-for-other-run" };
    if (!(await store.get(LOCK_KEY))) break;
  }
  const latest = await getCachedDigest(store);
  if (latest) return { data: latest, source: "cache" };
  throw new Error("Another run is in progress and didn't finish in time. Please try again in a minute.");
}

// ---------------------------------------------------------------- rate limits
export async function rateLimit(store: Store, action: string, who: string, limit: number, windowSeconds: number) {
  const slot = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${action}:${createHash("sha256").update(who).digest("hex").slice(0, 16)}:${slot}`;
  const count = await store.incr(key, windowSeconds);
  const retryAfterSeconds = (slot + 1) * windowSeconds - Math.floor(Date.now() / 1000);
  return { ok: count <= limit, retryAfterSeconds };
}

export function clientId(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

// ---------------------------------------------------------------- secrets
/** Constant-time comparison, so response timing can't reveal the secret. */
export function secretMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export const demoPasswordMatches = (given: string) => secretMatches(given.trim(), env("DEMO_PASSWORD"));

// ---------------------------------------------------------------- Friday schedule
/** India-time date (YYYY-MM-DD) of the Friday in the current Friday-to-Thursday week. */
export function fridayKey(nowUnix: number): string {
  const ist = new Date((nowUnix + IST_OFFSET) * 1000);
  const daysSinceFriday = (ist.getUTCDay() + 2) % 7; // Fri=0, Sat=1, ... Thu=6
  return new Date(ist.getTime() - daysSinceFriday * 86400_000).toISOString().slice(0, 10);
}

/** Next Friday 18:00 IST (12:30 UTC), matching the cron "30 12 * * 5" (Vercel Hobby runs it within that hour). */
export function nextScheduledRun(nowUnix: number): number {
  const d = new Date(nowUnix * 1000);
  const daysAhead = (5 - d.getUTCDay() + 7) % 7;
  const candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead, 12, 30) / 1000;
  return candidate > nowUnix ? candidate : candidate + 7 * 86400;
}

export interface FridayRecord {
  week: string; // fridayKey
  status: "sending" | "sent" | "failed";
  at: number;
  messages?: number;
  error?: string;
}

/** Claims this week's Friday send. Returns false if it was already sent (or is being sent). */
export async function claimFridaySend(store: Store, week: string): Promise<boolean> {
  return store.setIfAbsent(`friday-sent:${week}`, { at: Math.floor(Date.now() / 1000) }, 10 * 24 * 3600);
}

/** After a failed send, let a retry happen. */
export async function releaseFridaySend(store: Store, week: string) {
  await store.del(`friday-sent:${week}`);
}

export const getLastFriday = (store: Store) => store.get<FridayRecord>(LAST_FRIDAY_KEY);
export const setLastFriday = (store: Store, record: FridayRecord) => store.set(LAST_FRIDAY_KEY, record);
