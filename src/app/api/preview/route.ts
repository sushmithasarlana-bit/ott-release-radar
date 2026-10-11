// "Preview this week's digest": full live pipeline (cached for a few hours),
// returned as it would appear in Telegram. Sends nothing. Open to anyone.
import { formatDigest } from "@/lib/digest";
import { friendlyError } from "@/lib/errors";
import { CACHE_FRESH_SECONDS, clientId, getDigest, rateLimit } from "@/lib/service";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const store = getStore();
    const limit = await rateLimit(store, "preview", clientId(request), 10, 600);
    if (!limit.ok)
      return Response.json(
        { ok: false, error: `Too many previews from your connection. Please wait ${Math.ceil(limit.retryAfterSeconds / 60)} min.` },
        { status: 429 },
      );

    const { data, source } = await getDigest(store, { maxAgeSeconds: CACHE_FRESH_SECONDS, reserveQuota: true });
    return Response.json({ ok: true, source, data, messages: formatDigest(data, { test: false }) });
  } catch (err) {
    console.error("preview failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 500 });
  }
}
