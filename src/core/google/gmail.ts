import { gmailAccessToken } from "./auth.js";

/** Read-only Gmail helpers: search messages and read their text. */

export interface MailMessage {
  id: string;
  receivedAt: number;
  from: string;
  subject: string;
  text: string;
}

/** Gmail API call with backoff on per-user rate/quota limits (403 quota, 429). */
async function api<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      headers: { authorization: `Bearer ${await gmailAccessToken()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return (await res.json()) as T;
    const body = (await res.text()).slice(0, 200);
    if ((res.status === 429 || (res.status === 403 && /quota|rate/i.test(body))) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 15_000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Gmail ${res.status}: ${body}`);
  }
}

function bodyText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => (p.parts ? p.parts.forEach(walk) : parts.push(p));
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  const chosen = plain ? [plain] : parts.filter((p) => p.mimeType === "text/html" && p.body?.data);
  return chosen
    .map((p) => Buffer.from(p.body.data, "base64url").toString("utf8"))
    .join("\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Messages matching a Gmail search query, newest first. `skip` avoids refetching ids already processed. */
export async function searchMail(query: string, max = 5, skip: (id: string) => boolean = () => false, paceMs = 0): Promise<MailMessage[]> {
  const list = await api<{ messages?: { id: string }[] }>(`messages?maxResults=${max}&q=${encodeURIComponent(query)}`);
  const out: MailMessage[] = [];
  for (const { id } of list.messages ?? []) {
    if (skip(id)) continue;
    if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
    const m = await api<any>(`messages/${id}?format=full`);
    const header = (n: string) => m.payload.headers.find((h: any) => h.name.toLowerCase() === n)?.value ?? "";
    out.push({ id, receivedAt: Number(m.internalDate), from: header("from"), subject: header("subject"), text: bodyText(m.payload) });
  }
  return out.sort((a, b) => b.receivedAt - a.receivedAt);
}

/** Poll until a message matching `query` arrives after `since` and `extract` finds something in it. */
export async function waitForMail<T>(opts: {
  query: string;
  since: number;
  extract: (m: MailMessage) => T | null;
  timeoutMs?: number;
  everyMs?: number;
}): Promise<{ value: T; message: MailMessage } | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  // Gmail's after: filter is per-second; keep a small margin for clock skew, then filter exactly below.
  const q = `${opts.query} after:${Math.floor(opts.since / 1000) - 60}`;
  while (Date.now() < deadline) {
    for (const m of await searchMail(q).catch(() => [])) {
      if (m.receivedAt < opts.since - 5_000) continue;
      const value = opts.extract(m);
      if (value !== null) return { value, message: m };
    }
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 5_000));
  }
  return null;
}
