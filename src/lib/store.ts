// Small key-value storage.
// - Deployed: Upstash Redis (added from the Vercel Marketplace), via its REST API.
// - Local development: JSON files in .data/ so no account is needed.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Store {
  kind: "redis" | "local-files";
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** Sets only if the key does not exist yet. Returns true if this call set it (atomic in Redis). */
  setIfAbsent(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>;
  /** Adds 1 and returns the new count; the key expires ttlSeconds after it was created. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  del(key: string): Promise<void>;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Storage is not connected (Upstash Redis environment variables are missing)");
  }
}

// ---------------------------------------------------------------- Redis (Upstash REST)
function redisStore(url: string, token: string): Store {
  const command = async <T>(...args: (string | number)[]): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new Error(`Storage error: ${body.error ?? `HTTP ${res.status}`}`);
    return body.result as T;
  };
  return {
    kind: "redis",
    async get<T>(key: string) {
      const raw = await command<string | null>("GET", key);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    async set(key, value, ttlSeconds) {
      const args: (string | number)[] = ["SET", key, JSON.stringify(value)];
      if (ttlSeconds) args.push("EX", ttlSeconds);
      await command(...args);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      const args: (string | number)[] = ["SET", key, JSON.stringify(value), "NX"];
      if (ttlSeconds) args.push("EX", ttlSeconds);
      return (await command<string | null>(...args)) === "OK";
    },
    async incr(key, ttlSeconds) {
      const count = await command<number>("INCR", key);
      if (count === 1) await command("EXPIRE", key, ttlSeconds);
      return count;
    },
    async del(key) {
      await command("DEL", key);
    },
  };
}

// ---------------------------------------------------------------- local files (development only)
interface FileEntry {
  value: unknown;
  expiresAt: number | null;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const fileFor = (key: string) => path.join(DATA_DIR, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);

async function readEntry(key: string): Promise<FileEntry | null> {
  try {
    const entry = JSON.parse(await readFile(fileFor(key), "utf8")) as FileEntry;
    return entry.expiresAt !== null && entry.expiresAt < Date.now() ? null : entry;
  } catch {
    return null;
  }
}

const fileStore: Store = {
  kind: "local-files",
  async get<T>(key: string) {
    return ((await readEntry(key))?.value as T) ?? null;
  },
  async set(key, value, ttlSeconds) {
    await mkdir(DATA_DIR, { recursive: true });
    const entry: FileEntry = { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null };
    await writeFile(fileFor(key), JSON.stringify(entry));
  },
  async setIfAbsent(key, value, ttlSeconds) {
    if (await readEntry(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  },
  async incr(key, ttlSeconds) {
    const entry = await readEntry(key);
    const count = ((entry?.value as number) ?? 0) + 1;
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(fileFor(key), JSON.stringify({ value: count, expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000 }));
    return count;
  },
  async del(key) {
    await rm(fileFor(key), { force: true });
  },
};

/** Redis when its variables are set; local files otherwise (but never on Vercel). */
export function getStore(): Store {
  // The Vercel Marketplace integration may use either naming style.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url.trim(), token.replace(/\s+/g, ""));
  if (process.env.VERCEL) throw new StorageNotConfiguredError();
  return fileStore;
}
