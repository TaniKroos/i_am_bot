import { randomInt } from "node:crypto";
import { getDb } from "../db.js";

/**
 * Telegram channel: alerts with buttons, and commands from the owner.
 * Locked to one Telegram user, paired with a one-time code printed on the Mac; everyone else is ignored.
 */

const API = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing in .env");
  return `https://api.telegram.org/bot${token}`;
};

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

const kv = {
  get: (key: string) => getDb().prepare("SELECT value FROM kv WHERE agent = 'telegram' AND key = ?").pluck().get(key) as string | undefined,
  set: (key: string, value: string) =>
    getDb().prepare("INSERT INTO kv (agent, key, value) VALUES ('telegram', ?, ?) ON CONFLICT(agent, key) DO UPDATE SET value = excluded.value").run(key, value),
  del: (key: string) => getDb().prepare("DELETE FROM kv WHERE agent = 'telegram' AND key = ?").run(key),
};

export const ownerChatId = () => kv.get("owner_chat_id");

export interface Button {
  text: string;
  /** Sent back to the bot when tapped (max 64 bytes). */
  data?: string;
  url?: string;
}

/** Message the owner. No-op (logged) until paired. */
export async function notifyOwner(text: string, buttons: Button[][] = []): Promise<void> {
  const chat = ownerChatId();
  if (!chat) {
    console.log(`[telegram not paired] ${text}`);
    return;
  }
  await call("sendMessage", {
    chat_id: chat,
    text,
    disable_web_page_preview: true,
    reply_markup: buttons.length
      ? { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) }
      : undefined,
  });
}

/** Start pairing: returns a code the owner sends as "/start <code>" within 10 minutes. */
export function beginPairing(): string {
  const code = String(randomInt(100000, 1000000));
  kv.set("pairing", JSON.stringify({ code, expires: Date.now() + 10 * 60_000 }));
  return code;
}

export type CommandHandler = (args: string, reply: (text: string, buttons?: Button[][]) => Promise<void>) => Promise<void>;
export type CallbackHandler = (data: string, reply: (text: string) => Promise<void>) => Promise<void>;

/** Long-poll for updates. Only the paired owner's messages reach the handlers. */
export async function pollTelegram(opts: {
  commands: Record<string, CommandHandler>;
  onCallback?: CallbackHandler;
  signal?: AbortSignal;
}): Promise<void> {
  let offset = Number(kv.get("offset") ?? 0);
  while (!opts.signal?.aborted) {
    let updates: any[] = [];
    try {
      updates = await call<any[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
    } catch (e) {
      console.error(String(e));
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      kv.set("offset", String(offset));
      const from = u.message?.from ?? u.callback_query?.from;
      const chatId = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? "");
      const text: string = u.message?.text ?? "";

      // Pairing: "/start <code>" from anyone, but only with the code printed on the owner's Mac.
      if (!ownerChatId() && text.startsWith("/start")) {
        const pairing = kv.get("pairing") ? JSON.parse(kv.get("pairing")!) : null;
        if (pairing && Date.now() < pairing.expires && text.split(/\s+/)[1] === pairing.code && u.message.chat.type === "private") {
          kv.set("owner_chat_id", chatId);
          kv.set("owner_user_id", String(from.id));
          kv.del("pairing");
          await call("sendMessage", { chat_id: chatId, text: "✅ Paired. grokBot will only listen to you from now on." });
        }
        continue;
      }
      if (String(from?.id) !== kv.get("owner_user_id")) continue; // not the owner: ignore silently

      const reply = async (t: string, buttons?: Button[][]) => {
        await call("sendMessage", {
          chat_id: chatId,
          text: t,
          disable_web_page_preview: true,
          reply_markup: buttons?.length ? { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } : undefined,
        });
      };
      if (u.callback_query) {
        await call("answerCallbackQuery", { callback_query_id: u.callback_query.id });
        await opts.onCallback?.(u.callback_query.data, reply);
        continue;
      }
      const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
      const handler = m ? opts.commands[m[1]] : undefined;
      if (handler) await handler(m![2].trim(), reply);
      else await reply(`Commands: ${Object.keys(opts.commands).map((c) => `/${c}`).join(" ")}`);
    }
  }
}
