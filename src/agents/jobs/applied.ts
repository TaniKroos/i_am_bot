import type { DB } from "../../core/db.js";
import { searchMail } from "../../core/google/gmail.js";

/**
 * Permanent ledger of everything the owner has applied to: the bot's own submissions and applications
 * found in Gmail confirmations (manual applications, the JobSeeker extension, other tools).
 * Used to never apply twice: same job id, or the same role reposted (same company + normalised title).
 */

export const REAPPLY_WINDOW_DAYS = 120;

const COMPANY_NOISE = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|technologies|technology|labs|careers?|job board|jobs)\b/g;
const TITLE_NOISE = /\b(remote|hybrid|onsite|on-site|india|bangalore|bengaluru|hyderabad|pune|mumbai|gurugram|gurgaon|noida|delhi|chennai|ncr)\b/g;
/** Non-global copy for .test(): a /g regex keeps lastIndex between calls and gives wrong answers. */
const LOCATION_WORD = new RegExp(TITLE_NOISE.source);

export function normCompany(c: string): string {
  return c.toLowerCase().replace(/&/g, " and ").replace(COMPANY_NOISE, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Same role → same fingerprint, across reposts and boards ("Sr." = "Senior", location and punctuation ignored). */
export function fingerprint(company: string, title: string): string {
  const t = title
    .toLowerCase()
    // Drop brackets only when they hold a location, work mode or id; keep specialisations like "(DevSecOps)".
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (all, a, b) => (LOCATION_WORD.test(a ?? b) || /\d{3,}|^\s*(open|frozen)\s*$/.test(a ?? b) ? " " : all))
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bjr\.?\b/g, "junior")
    .replace(/\bsde\b/g, "software development engineer")
    .replace(/\bswe\b/g, "software engineer")
    .replace(TITLE_NOISE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${normCompany(company)}|${t}`;
}

export function recordApplied(
  db: DB,
  a: { jobId?: string; company: string; title?: string; req?: string; raw?: string; source: "bot" | "gmail" | "workday"; appliedAt: number; ref: string },
): void {
  db.prepare(
    `INSERT INTO applied (job_id, company, title, fingerprint, source, applied_at, ref, req, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING`,
  ).run(
    a.jobId ?? null,
    normCompany(a.company),
    a.title ?? null,
    a.title ? fingerprint(a.company, a.title) : null,
    a.source,
    a.appliedAt,
    a.ref,
    a.req ?? null,
    a.raw ?? null,
  );
}

/** Why this job must not be applied to, or null if it's fine. */
export function alreadyApplied(db: DB, job: { id: string; company_name: string; title: string }): string | null {
  const byId = db.prepare("SELECT source, applied_at FROM applied WHERE job_id = ? LIMIT 1").get(job.id) as any;
  if (byId) return `already applied to this job (${byId.source}, ${new Date(byId.applied_at).toISOString().slice(0, 10)})`;
  // Requisition ids from confirmation emails match the careers site's job id/URL (Oracle id, Workday R-…, etc.).
  const reqs = db.prepare("SELECT req, applied_at FROM applied WHERE company = ? AND req IS NOT NULL").all(normCompany(job.company_name)) as any[];
  const hay = `${job.id} ${(job as any).url ?? ""} ${(job as any).external_id ?? ""}`.toLowerCase();
  const hit = reqs.find((r) => hay.includes(String(r.req).toLowerCase()));
  if (hit) return `already applied to requisition ${hit.req} (${new Date(hit.applied_at).toISOString().slice(0, 10)})`;
  const since = Date.now() - REAPPLY_WINDOW_DAYS * 86_400_000;
  const same = db
    .prepare("SELECT source, applied_at, title FROM applied WHERE fingerprint = ? AND applied_at >= ? LIMIT 1")
    .get(fingerprint(job.company_name, job.title), since) as any;
  if (same) return `already applied to "${same.title}" at ${job.company_name} (${same.source}, ${new Date(same.applied_at).toISOString().slice(0, 10)}): likely a repost`;
  return null;
}

/** Applications at this company in the window, from the ledger (bot and Gmail). */
export function appliedAtCompany(db: DB, company: string, sinceMs: number): number {
  // Distinct applications: the bot's record and its Gmail confirmation share a fingerprint and count once.
  return db
    .prepare("SELECT COUNT(DISTINCT COALESCE(req, fingerprint, ref)) FROM applied WHERE company = ? AND applied_at >= ?")
    .pluck()
    .get(normCompany(company), sinceMs) as number;
}

const CONFIRMATION_QUERY =
  '(subject:"thank you for applying" OR subject:"thanks for applying" OR subject:"application received" OR subject:"we received your application" OR subject:"thank you for your application" OR subject:"thank you for your interest" OR subject:"your application to") -subject:"security code"';

/** Sender names that aren't the company's name. */
const SENDER_ALIASES: Record<string, string> = {
  "amex careers": "American Express",
  travelhrportal: "American Express GBT",
  wellsfargohr: "Wells Fargo",
  "bnycareerspeople": "BNY",
  r1rcm: "R1 RCM",
};
const SENDER_NOISE = /\b(careers?|hiring team|people services|recruiting( team)?|human resources|hr( team)?|talent( acquisition)?|experienced talent|do-?not-?reply|no-?reply|notifications?|team|@ ?icims)\b/gi;
const GENERIC_SENDER = /^(no-?reply|notification|notifications|donotreply|careers?)$/i;
const LOOKS_LIKE_TITLE = /engineer|developer|analyst|scientist|architect|programmer|associate|intern|manager|\b\d{5,}\b/i;

/** company, title and requisition id from one confirmation email. */
export function parseConfirmation(raw: { from: string; subject: string; text: string }): { company: string | null; title: string | null; req: string | null } {
  const strip = (s: string) => s.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/&amp;/g, "&");
  const m = { from: strip(raw.from), subject: strip(raw.subject), text: strip(raw.text) };
  let display = m.from.replace(/<.*>/, "").replace(/["']/g, "").trim();
  // "Abhijit Lamb from Smiths Detection" → "Smiths Detection"; a bare address as display name → its domain's name.
  display = display.match(/\bfrom\s+(.+)$/i)?.[1] ?? display;
  if (display.includes("@")) display = display.split("@")[1].split(".").slice(-2, -1)[0] ?? display;
  const email = m.from.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1]?.toLowerCase() ?? "";
  const [local, domain] = email.split("@");
  let subjectTarget = m.subject.match(/(?:applying|application|interest|applying)\s+(?:to|at|in|with)\s+(.+?)\s*[!.]*$/i)?.[1]?.replace(/[—–-]\s*here.*$/i, "").trim() ?? null;
  // "…Application to R1 for Software Engineer II" → company "R1", title "Software Engineer II"
  let subjectTitle: string | null = null;
  const forSplit = subjectTarget?.match(/^(.+?)\s+for\s+(.+)$/i);
  if (forSplit && !LOOKS_LIKE_TITLE.test(forSplit[1])) [subjectTarget, subjectTitle] = [forSplit[1], forSplit[2]];

  let company: string | null = null;
  const alias = SENDER_ALIASES[display.toLowerCase()] ?? SENDER_ALIASES[(local ?? "").toLowerCase()];
  if (alias) company = alias;
  else if (domain?.endsWith("myworkday.com") && local && !GENERIC_SENDER.test(local)) company = local;
  else if (subjectTarget && !LOOKS_LIKE_TITLE.test(subjectTarget)) company = subjectTarget.split(/\s+-\s+/)[0];
  else {
    const cleaned = display.replace(/\bfrom\b.*$/i, "").replace(SENDER_NOISE, " ").replace(/\s+/g, " ").trim();
    company = cleaned && !GENERIC_SENDER.test(cleaned) ? cleaned : null;
  }

  const text = m.text.replace(/\s+/g, " ");
  const titleFromSubject = subjectTitle ?? (subjectTarget && LOOKS_LIKE_TITLE.test(subjectTarget) ? subjectTarget.replace(/\s*-\s*[A-Z]*\d{5,}\s*$/, "") : null);
  const patterns = [
    /following position:\s*(?:R-?\d{5,}\s+)?(.{3,80}?)(?:\.|$| Thank| We )/i,
    /application for the position of (.{3,90}?) has been/i,
    /application for (?:the |our )?(?:role|position)(?: of)?:? (.{3,90}?)(?: has been| \.|\. |,| and | at |$)/i,
    /(?:apply|applying) for the role of (.{3,90}?)(?:-\d{5,}|\. )/i,
    /application for (?:the )?(.{3,90}?) (?:role|position)\b/i,
    /interest in the position of (.{3,90}?)(?:, \d{5,}| at )/i,
    /application for ([A-Z][^!.]{2,80}?)(?: \(Job number| and are|!|\. )/,
    /applying for the (.{3,80}?) (?:role|position) at/i,
  ];
  let title = titleFromSubject;
  for (const p of patterns) {
    if (title) break;
    title = text.match(p)?.[1]?.trim() ?? null;
  }
  if (title) title = title.replace(/\s+(?:and will|to assess|which|so that|at\s+[A-Z][\w.&]*(?:\s+[A-Z][\w.&]*)*$).*$/, "").replace(/^(?:the|our)\s+/i, "").trim();
  if (title && (title.length < 4 || title.split(/\s+/).length > 12 || /meantime|conversation|our team|organization/i.test(title))) title = null;

  // Requisition ids: prefixed ones anywhere; bare 6-9 digit numbers only in the subject or next to "Job number"/"Req"/a dash
  // (so postcodes and phone numbers in signatures don't count).
  const req =
    `${m.subject} ${text.slice(0, 800)}`.match(/\b(R-?\d{5,}|JR[-_]?\d{4,}|REF\w{4,})\b/)?.[1] ??
    m.subject.match(/\b(\d{6,9})\b/)?.[1] ??
    text.slice(0, 800).match(/(?:job number:?\s*|req(?:uisition)?(?:\s*id)?:?\s*|[-–,]\s*)(\d{6,9})\b/i)?.[1] ??
    null;
  if (title)
    title = title
      .replace(/^(?:R-?\d{5,}|JR[-_]?\d{4,})\s+/, "") // leading requisition id
      .replace(/\s*\((?:open|frozen|closed)\)\s*$/i, "") // Workday status tag
      .replace(/^.*?\s-\s\d{4,}\s-\s/, "") // "BNY - 77036 - Associate, …"
      .replace(/[-,]?\s*\b(R-?\d{5,}|\d{6,9})\b.*$/, "")
      .replace(/\s+position$/i, "")
      .trim();
  return { company, title: title || null, req };
}

/** Recompute stored fingerprints after the fingerprint rules change. */
export function refreshFingerprints(db: DB): void {
  const rows = db.prepare("SELECT id, company, title FROM applied WHERE title IS NOT NULL").all() as { id: number; company: string; title: string }[];
  const upd = db.prepare("UPDATE applied SET fingerprint = ? WHERE id = ?");
  db.transaction(() => rows.forEach((r) => upd.run(fingerprint(r.company, r.title), r.id)))();
}

/** Pull application confirmations from Gmail into the ledger. Returns how many were new. */
export async function syncAppliedFromGmail(db: DB, days = 90): Promise<number> {
  refreshFingerprints(db);
  const before = db.prepare("SELECT COUNT(*) FROM applied").pluck().get() as number;
  const seen = db.prepare("SELECT 1 FROM applied WHERE ref = ?").pluck();
  // Paced and incremental: never burst Gmail's per-minute quota (security codes share it).
  for (const m of await searchMail(`${CONFIRMATION_QUERY} newer_than:${days}d`, 100, (id) => Boolean(seen.get(`gmail:${id}`)), 400)) {
    const p = parseConfirmation(m);
    if (!p.company) continue;
    recordApplied(db, {
      company: p.company,
      title: p.title ?? undefined,
      req: p.req ?? undefined,
      raw: `${m.from} | ${m.subject}`,
      source: "gmail",
      appliedAt: m.receivedAt,
      ref: `gmail:${m.id}`,
    });
  }
  return (db.prepare("SELECT COUNT(*) FROM applied").pluck().get() as number) - before;
}
