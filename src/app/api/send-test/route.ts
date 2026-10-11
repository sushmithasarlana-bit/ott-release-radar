// "Send test digest to Telegram": posts the digest marked [TEST]. Needs
// DEMO_PASSWORD. Never touches the Friday "already sent" marker.
import { formatDigest } from "@/lib/digest";
import { friendlyError } from "@/lib/errors";
import { CACHE_FRESH_SECONDS, clientId, demoPasswordMatches, getDigest, rateLimit } from "@/lib/service";
import { sendMessages } from "@/lib/sources/telegram";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) return Response.json({ ok: false, error: "Please enter the demo password." }, { status: 400 });

    const store = getStore();
    // Counts every attempt (right or wrong), so the password can't be guessed quickly.
    const perPerson = await rateLimit(store, "send-test", clientId(request), 5, 3600);
    if (!perPerson.ok)
      return Response.json(
        { ok: false, error: `Too many test sends from your connection. Please wait ${Math.ceil(perPerson.retryAfterSeconds / 60)} min.` },
        { status: 429 },
      );
    if (!demoPasswordMatches(password)) return Response.json({ ok: false, error: "That password isn't right." }, { status: 401 });

    // Keeps the channel from being flooded, whoever is clicking.
    const overall = await rateLimit(store, "send-test-all", "everyone", 20, 24 * 3600);
    if (!overall.ok) return Response.json({ ok: false, error: "The daily limit for test sends has been reached. Please try tomorrow." }, { status: 429 });

    const { data, source } = await getDigest(store, { maxAgeSeconds: CACHE_FRESH_SECONDS, reserveQuota: true });
    const messages = formatDigest(data, { test: true });
    await sendMessages(messages);
    return Response.json({ ok: true, source, sentMessages: messages.length, generatedAt: data.generatedAt });
  } catch (err) {
    console.error("send-test failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 500 });
  }
}
