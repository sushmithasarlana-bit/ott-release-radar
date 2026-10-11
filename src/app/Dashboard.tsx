// Server part of the dashboard: reads the last run from storage (no API calls)
// and hands it to the interactive client component.
import { connection } from "next/server";
import type { ComponentProps } from "react";
import { KEEP_GENRES } from "@/lib/enrich";
import { friendlyError } from "@/lib/errors";
import { GEMINI_MODELS } from "@/lib/sources/gemini";
import { CACHE_FRESH_SECONDS, getCachedDigest, getLastFriday, nextScheduledRun } from "@/lib/service";
import { getStore } from "@/lib/store";
import RadarClient from "./RadarClient";

type Props = ComponentProps<typeof RadarClient>;

async function loadDashboard(): Promise<Props> {
  const nextRun = nextScheduledRun(Math.floor(Date.now() / 1000));
  // Server-only facts the page explains (passed in so the browser never imports server code).
  const info = { geminiModels: [...GEMINI_MODELS], keepGenres: [...KEEP_GENRES] };
  const base = { nextRun, cacheHours: CACHE_FRESH_SECONDS / 3600, info };
  try {
    const store = getStore();
    const [initialData, lastFriday] = await Promise.all([getCachedDigest(store), getLastFriday(store)]);
    return { ...base, initialData, lastFriday };
  } catch (err) {
    // The page still renders; it says what's wrong instead of showing a blank page.
    return { ...base, initialData: null, lastFriday: null, loadError: friendlyError(err) };
  }
}

export default async function Dashboard() {
  await connection(); // read storage at request time, not at build time
  return <RadarClient {...await loadDashboard()} />;
}
