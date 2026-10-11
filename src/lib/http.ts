// Small fetch wrapper. Error messages name the API and status only, never the
// request URL or headers, so secrets can't leak into logs or the web page.

export type ApiSource = "Streaming Availability" | "TMDB" | "Gemini" | "Telegram";

export class ApiError extends Error {
  source: ApiSource;
  status: number | null;
  constructor(source: ApiSource, status: number | null, message: string) {
    super(`${source}: ${message}`);
    this.source = source;
    this.status = status;
  }
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  ms: number;
}

export async function getJson<T>(
  source: ApiSource,
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<JsonResponse<T>> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new ApiError(source, null, timedOut ? `no response within ${timeoutMs / 1000}s` : "could not connect");
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(source, res.status, `unexpected non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) throw new ApiError(source, res.status, `HTTP ${res.status} ${describeError(data)}`.trim());
  return { data: data as T, headers: res.headers, ms: Date.now() - started };
}

function describeError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>).message : b.error;
  const msg = b.message ?? b.status_message ?? b.description ?? nested;
  return typeof msg === "string" ? `- ${msg.slice(0, 200)}` : "";
}
