// The scheduled Friday digest. Two Vercel crons call this route (vercel.json):
//   "30 12 * * 5"  Friday 18:00 IST - the real run
//   "30 3 * * 6"   Saturday 09:00 IST - backup, in case Friday's run was missed
//                  or failed (Vercel does not retry cron jobs)
// On the Hobby plan Vercel runs each within its hour (Friday: 17:30-18:29 IST).
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else is refused.
// A per-week marker in storage makes sure only one of them (or a duplicate
// delivery) actually sends, at most once per Friday-to-Thursday week.
import { formatDigest } from "@/lib/digest";
import { friendlyError } from "@/lib/errors";
import { claimFridaySend, fridayKey, getDigest, releaseFridaySend, secretMatches, setLastFriday } from "@/lib/service";
import { sendMessages } from "@/lib/sources/telegram";
import { getStore } from "@/lib/store";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ ok: false, error: "CRON_SECRET is not set on the server." }, { status: 500 });
  const auth = request.headers.get("authorization") ?? "";
  if (!secretMatches(auth, `Bearer ${secret}`)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let store;
  try {
    store = getStore();
  } catch (err) {
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 500 });
  }
  const week = fridayKey(Math.floor(Date.now() / 1000));
  if (!(await claimFridaySend(store, week))) return Response.json({ ok: true, skipped: `Digest for the week of ${week} was already sent.` });
  console.log(`cron: sending digest for week of ${week} (schedule ${request.headers.get("x-vercel-cron-schedule") ?? "manual"})`);

  await setLastFriday(store, { week, status: "sending", at: Math.floor(Date.now() / 1000) });
  try {
    // Fresh data for the real digest (a run from the last hour is fine).
    const { data } = await getDigest(store, { maxAgeSeconds: 3600, reserveQuota: false });
    const messages = formatDigest(data, { test: false });
    await sendMessages(messages);
    await setLastFriday(store, { week, status: "sent", at: Math.floor(Date.now() / 1000), messages: messages.length });
    return Response.json({ ok: true, week, sentMessages: messages.length });
  } catch (err) {
    // Allow a retry, since nothing (or not everything) was delivered.
    await releaseFridaySend(store, week);
    await setLastFriday(store, { week, status: "failed", at: Math.floor(Date.now() / 1000), error: friendlyError(err) });
    console.error("cron failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 500 });
  }
}
