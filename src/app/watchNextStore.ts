// The "Watch Next" shortlist: titles the viewer hearted, plus their Final watch
// and Next watch picks. Saved in this browser only (localStorage), so each
// visitor has their own list. Works (in memory) even if storage is blocked.
import { useSyncExternalStore } from "react";
import type { DigestTitle } from "@/lib/pipeline";

export interface ShortlistItem {
  id: string;
  title: string;
  poster: string | null;
  platforms: string; // "Netflix + Prime Video"
  link: string | null;
  kind: DigestTitle["kind"];
  verdict: "WATCH" | "SKIP" | null;
  score: number | null;
  addedAt: number;
}

export interface WatchNext {
  items: ShortlistItem[];
  finalId: string | null;
  nextId: string | null;
}

const KEY = "ott-radar-watch-next-v1";
const EMPTY: WatchNext = { items: [], finalId: null, nextId: null };

let cachedRaw: string | null = null;
let cached: WatchNext = EMPTY;
const listeners = new Set<() => void>();

function parse(raw: string | null): WatchNext {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<WatchNext>;
    const items = Array.isArray(v.items) ? v.items.filter((i) => i && typeof i.id === "string" && typeof i.title === "string") : [];
    const has = (id: unknown) => typeof id === "string" && items.some((i) => i.id === id);
    return { items, finalId: has(v.finalId) ? (v.finalId as string) : null, nextId: has(v.nextId) ? (v.nextId as string) : null };
  } catch {
    return EMPTY;
  }
}

function read(): WatchNext {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return cached; // storage blocked: keep the in-memory list
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

function write(next: WatchNext) {
  cached = next;
  cachedRaw = JSON.stringify(next);
  try {
    localStorage.setItem(KEY, cachedRaw);
  } catch {
    // Private window or blocked storage: the list still works until the tab closes.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === KEY && listener(); // other tabs
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current shortlist; re-renders when it changes (also across tabs). */
export function useWatchNext(): WatchNext {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export const isHearted = (state: WatchNext, id: string) => state.items.some((i) => i.id === id);

/** Adds or removes a title. Returns true if it was added. */
export function toggleHeart(t: DigestTitle): boolean {
  const state = read();
  if (isHearted(state, t.id)) {
    removeItem(t.id);
    return false;
  }
  const item: ShortlistItem = {
    id: t.id,
    title: t.title,
    poster: t.poster,
    platforms: t.platforms.map((p) => p.name).join(" + "),
    link: t.platforms.find((p) => p.link)?.link ?? t.link,
    kind: t.kind,
    verdict: t.verdict.verdict,
    score: t.verdict.score,
    addedAt: Date.now(),
  };
  write({ ...state, items: [item, ...state.items] });
  return true;
}

export function removeItem(id: string) {
  const s = read();
  write({ items: s.items.filter((i) => i.id !== id), finalId: s.finalId === id ? null : s.finalId, nextId: s.nextId === id ? null : s.nextId });
}

/** Makes a title the Final watch (or clears it if it already is). One title can't hold both slots. */
export function setFinal(id: string) {
  const s = read();
  write({ ...s, finalId: s.finalId === id ? null : id, nextId: s.nextId === id ? s.finalId : s.nextId });
}

/** Makes a title the Next watch (or clears it if it already is). */
export function setNext(id: string) {
  const s = read();
  write({ ...s, nextId: s.nextId === id ? null : id, finalId: s.finalId === id ? s.nextId : s.finalId });
}

export function clearAll() {
  write(EMPTY);
}
