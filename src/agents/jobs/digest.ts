import type { AgentContext } from "../../core/agent.js";
import { notifyOwner } from "../../core/channels/telegram.js";
import { alreadyApplied } from "./applied.js";

/** Job statuses worth applying to by hand: matched, or stopped somewhere in the bot's own pipeline. */
const OPEN = ["matched", "needs_user", "waiting_adapter", "tailoring", "ready", "applying", "dry_run"];

export interface DigestJob {
  id: string;
  score: number;
  title: string;
  company_name: string;
  location: string | null;
  url: string;
  apply_url: string | null;
}

/** Matched jobs not sent in a digest yet, best first; anything already applied to (bot or Gmail) is left out. */
export function pendingDigest(ctx: AgentContext): DigestJob[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, score, title, company_name, location, url, apply_url, external_id FROM jobs
       WHERE digested_at IS NULL AND status IN (${OPEN.map(() => "?").join(", ")})
       ORDER BY score DESC, COALESCE(posted_at, first_seen_at) DESC`,
    )
    .all(...OPEN) as (DigestJob & { external_id: string })[];
  return rows.filter((r) => !alreadyApplied(ctx.db, r));
}

/** Telegram caps a message at 4096 characters: split on job boundaries. */
function chunks(header: string, jobs: DigestJob[]): string[] {
  const out: string[] = [];
  let cur = header;
  jobs.forEach((j, i) => {
    const line = `\n\n${i + 1}. [${j.score}] ${j.title} @ ${j.company_name}${j.location ? ` · ${j.location}` : ""}\n${j.apply_url || j.url}`;
    if (cur.length + line.length > 3900) (out.push(cur), (cur = ""));
    cur += line;
  });
  out.push(cur);
  return out;
}

/** Send every pending match to Telegram and mark it sent. Returns how many went out. */
export async function sendDigest(ctx: AgentContext): Promise<number> {
  const jobs = pendingDigest(ctx);
  if (!jobs.length) {
    await notifyOwner("📋 No new matches since the last digest.");
    return 0;
  }
  for (const text of chunks(`📋 ${jobs.length} job(s) to apply to, best match first:`, jobs)) await notifyOwner(text);
  const mark = ctx.db.prepare("UPDATE jobs SET digested_at = ? WHERE id = ?");
  const now = Date.now();
  ctx.db.transaction(() => jobs.forEach((j) => mark.run(now, j.id)))();
  ctx.log("digest_sent", { count: jobs.length });
  return jobs.length;
}
