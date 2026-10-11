// Sends the digest to the Telegram channel (HTML, link previews off).
import { env } from "../env";
import { ApiError, getJson } from "../http";

interface SendResult {
  ok: boolean;
  result?: { message_id: number };
}

/** Sends messages in order. Waits and retries once if Telegram asks us to slow down. */
export async function sendMessages(messages: string[]): Promise<number[]> {
  const url = `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendMessage`;
  const ids: number[] = [];
  for (const text of messages) {
    const body = JSON.stringify({
      chat_id: env("TELEGRAM_CHAT_ID"),
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    const send = () => getJson<SendResult>("Telegram", url, { method: "POST", headers: { "content-type": "application/json" }, body });
    let res;
    try {
      res = await send();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 429)) throw err;
      await new Promise((r) => setTimeout(r, 3000));
      res = await send();
    }
    ids.push(res.data.result?.message_id ?? 0);
  }
  return ids;
}
