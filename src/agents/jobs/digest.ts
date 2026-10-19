import type { AgentContext } from "../../core/agent.js";
import { notifyOwner } from "../../core/channels/telegram.js";
import { alreadyApplied } from "./applied.js";
import { followUps, referralMessages } from "./referrals.js";

/** Job statuses worth applying to by hand: matched, or stopped somewhere in the bot's own pipeline. */
export const OPEN = ["matched", "needs_user", "waiting_adapter", "tailoring", "ready", "applying", "dry_run"];

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

/** Companies (best job each) that get a referral message per digest; two searches each, within Brave's free tier. */
export const REFERRAL_COMPANIES = 8;

/**
 * Send every pending match to Telegram and mark it sent, then referral leads for the best few companies
 * and any referral asks due a follow-up. Returns how many jobs went out.
 */
export async function sendDigest(ctx: AgentContext, opts: { referrals?: number } = {}): Promise<number> {
  const jobs = pendingDigest(ctx);
  const due = followUps(ctx);
  if (!jobs.length) {
    await notifyOwner("📋 No new matches since the last digest.");
    if (due) await notifyOwner(due.text, due.buttons);
    return 0;
  }
  for (const text of chunks(`📋 ${jobs.length} job(s) to apply to, best match first:`, jobs)) await notifyOwner(text);
  const seen = new Set<string>();
  const best = jobs.filter((j) => !seen.has(j.company_name.toLowerCase()) && seen.add(j.company_name.toLowerCase())).slice(0, opts.referrals ?? REFERRAL_COMPANIES);
  for (const m of await referralMessages(ctx, best)) await notifyOwner(m.text, m.buttons);
  if (due) await notifyOwner(due.text, due.buttons);
  const mark = ctx.db.prepare("UPDATE jobs SET digested_at = ? WHERE id = ?");
  const now = Date.now();
  ctx.db.transaction(() => jobs.forEach((j) => mark.run(now, j.id)))();
  ctx.log("digest_sent", { count: jobs.length });
  return jobs.length;
}
