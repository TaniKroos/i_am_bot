import type { AgentContext } from "../../core/agent.js";
import type { Button } from "../../core/channels/telegram.js";
import { decodeEntities, throttle } from "./sources/http.js";
import { loadProfile } from "./profile.js";
import type { DigestJob } from "./digest.js";

/**
 * Referral finder: people at a matched job's company who could refer the owner.
 * Search engine only (Brave Search, `site:linkedin.com/in`): the bot never logs in to LinkedIn or sends anything.
 * The owner opens the profile and sends the drafted note by hand, then taps "Sent" so follow-ups can be tracked.
 */

/** Reuse a company's people for this long before searching again (Brave free tier: ~2,000 queries a month). */
const PEOPLE_TTL_MS = 14 * 24 * 3600_000;
const FOLLOW_UP_AFTER_MS = 5 * 24 * 3600_000;
const PER_JOB = 4;
/** LinkedIn caps a free account's connection note at 200 characters. */
const NOTE_MAX = 200;
const DEFAULT_NOTE =
  "Hi {first}, I work as {role} at {employer} ({years} yrs) and I'm applying for {title} at {company}. Would you be open to referring me? Happy to share my resume. Thanks!";

const INDIAN_CITIES = ["Bengaluru", "Bangalore", "Hyderabad", "Pune", "Mumbai", "Chennai", "Gurugram", "Gurgaon", "Noida", "Delhi", "Kolkata", "Ahmedabad", "Jaipur", "Kochi", "Chandigarh", "Indore", "Coimbatore", "Trivandrum", "Thiruvananthapuram"];

export interface Person {
  id: number;
  name: string;
  headline: string;
  url: string;
  alumni: boolean;
  contactedAt: number | null;
}

export const referralMigrations = [
  {
    id: "jobs:009",
    sql: `
      CREATE TABLE people (
        id INTEGER PRIMARY KEY,
        company TEXT NOT NULL,          -- lower-cased company name
        url TEXT NOT NULL UNIQUE,       -- linkedin.com/in/... profile
        name TEXT NOT NULL,
        headline TEXT,
        alumni INTEGER NOT NULL DEFAULT 0,
        rank INTEGER NOT NULL DEFAULT 0,
        found_at INTEGER NOT NULL
      );
      CREATE INDEX people_company ON people(company, rank);
      -- When a company was last searched (empty results count too, so we don't re-query every sweep).
      CREATE TABLE people_searches (company TEXT PRIMARY KEY, searched_at INTEGER NOT NULL, found INTEGER NOT NULL);
      -- Referral asks the owner marked as sent from Telegram.
      CREATE TABLE outreach (
        person_id INTEGER NOT NULL REFERENCES people(id),
        job_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        followed_up_at INTEGER,
        PRIMARY KEY (person_id, job_id)
      );
    `,
  },
];

const companyKey = (name: string) => name.toLowerCase().trim();

/** "Bengaluru, KA, India" → "Bengaluru"; anything else → "India". */
export function regionOf(location: string | null): string {
  const l = (location ?? "").toLowerCase();
  return INDIAN_CITIES.find((c) => l.includes(c.toLowerCase())) ?? "India";
}

/** Brave Search: free plan allows one query per second. */
async function searchBrave(q: string): Promise<{ title: string; url: string; description: string }[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  await throttle("brave", 1100);
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "20", country: "IN" })}`;
  const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": key }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429) throw new Error("Brave Search: rate limit or monthly quota reached");
  if (!res.ok) throw new Error(`Brave Search ${res.status}`);
  const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ""));
  return (data.web?.results ?? []).map((r) => ({ title: strip(r.title), url: r.url, description: strip(r.description ?? "") }));
}

/** Keep current employees of `company` from LinkedIn profile results, best referrers first. */
export function parsePeople(results: { title: string; url: string; description: string }[], company: string, region: string, schoolTerms: string[]) {
  const c = company.toLowerCase();
  const out = new Map<string, { name: string; headline: string; url: string; alumni: boolean; rank: number }>();
  for (const r of results) {
    const m = r.url.match(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i);
    if (!m) continue;
    const url = `https://www.linkedin.com/in/${m[1]}`;
    const [name, ...rest] = r.title.replace(/\s*\|\s*LinkedIn.*$/i, "").split(/\s+[-–—]\s+/);
    const headline = rest.join(" · ");
    const text = `${r.title} ${r.description}`.toLowerCase();
    // Must work there now: named in the result, and not as a former employer.
    if (!text.includes(c) || new RegExp(`(ex-|former|previously|formerly)[^.]{0,20}${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text)) continue;
    if (!name || name.length > 60 || /linkedin/i.test(name)) continue;
    const alumni = schoolTerms.some((s) => text.includes(s));
    const h = `${headline} ${r.description}`.toLowerCase();
    const rank =
      (alumni ? 4 : 0) +
      (/engineer|developer|sde|programmer|architect|tech lead/.test(h) ? 2 : 0) +
      (/recruit|talent|hiring|\bhr\b/.test(h) ? 1 : 0) +
      (text.includes(region.toLowerCase()) ? 1 : 0);
    if (!out.has(url)) out.set(url, { name: name.trim(), headline, url, alumni, rank });
  }
  return [...out.values()];
}

/** Search once per company per PEOPLE_TTL and cache. Returns false when no search was possible (no API key). */
async function refreshPeople(ctx: AgentContext, company: string, region: string): Promise<boolean> {
  if (!process.env.BRAVE_API_KEY) return false;
  const key = companyKey(company);
  const last = ctx.db.prepare("SELECT searched_at FROM people_searches WHERE company = ?").pluck().get(key) as number | undefined;
  if (last && Date.now() - last < PEOPLE_TTL_MS) return true;

  const schoolTerms = college() ? [college().toLowerCase()] : [];
  const schoolQuery = schoolTerms.map((s: string) => `"${s}"`).join(" OR ");
  const queries = [
    `site:linkedin.com/in "${company}" (engineer OR developer OR recruiter) ${region}`,
    ...(schoolQuery ? [`site:linkedin.com/in "${company}" (${schoolQuery})`] : []),
  ];
  const results = (await Promise.all(queries.map(searchBrave))).flat();
  const people = parsePeople(results, company, region, schoolTerms);
  const now = Date.now();
  const upsert = ctx.db.prepare(
    `INSERT INTO people (company, url, name, headline, alumni, rank, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET company = excluded.company, headline = excluded.headline, alumni = MAX(alumni, excluded.alumni), rank = excluded.rank, found_at = excluded.found_at`,
  );
  ctx.db.transaction(() => {
    for (const p of people) upsert.run(key, p.url, p.name, p.headline, p.alumni ? 1 : 0, p.rank, now);
    ctx.db.prepare("INSERT INTO people_searches (company, searched_at, found) VALUES (?, ?, ?) ON CONFLICT(company) DO UPDATE SET searched_at = excluded.searched_at, found = excluded.found").run(key, now, people.length);
  })();
  ctx.log("people_found", { company, count: people.length });
  return true;
}

export function peopleFor(ctx: AgentContext, company: string): Person[] {
  return (
    ctx.db
      .prepare(
        `SELECT p.id, p.name, p.headline, p.url, p.alumni, MAX(o.sent_at) contacted_at FROM people p
         LEFT JOIN outreach o ON o.person_id = p.id WHERE p.company = ? GROUP BY p.id ORDER BY p.rank DESC, p.found_at DESC LIMIT ?`,
      )
      .all(companyKey(company), PER_JOB) as any[]
  ).map((r) => ({ id: r.id, name: r.name, headline: r.headline ?? "", url: r.url, alumni: !!r.alumni, contactedAt: r.contacted_at }));
}

/** Connection note from the owner's own facts; profile.yaml `referral.note` overrides the template. */
export function draftNote(job: DigestJob, first: string): string {
  const p = loadProfile() as any;
  const fill = (title: string) =>
    String(p.referral?.note ?? DEFAULT_NOTE)
      .replaceAll("{first}", first)
      .replaceAll("{role}", p.facts?.current_title ?? "")
      .replaceAll("{employer}", p.facts?.current_employer ?? "")
      .replaceAll("{years}", String(p.facts?.total_experience_years ?? ""))
      .replaceAll("{title}", title)
      .replaceAll("{company}", job.company_name);
  // Long job titles get shortened ("Software Engineer - Cloud: Azure" → "Software Engineer") to fit LinkedIn's limit.
  let note = fill(job.title);
  if (note.length > NOTE_MAX) note = fill(job.title.split(/\s+[-–,:|(]\s*|\s*[-–,:|(]\s+/)[0]);
  return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX - 1) + "…" : note;
}

/** The owner's college (full name, first of `facts.university_search`): alumni are the warmest referrers. */
const college = (): string => (loadProfile().facts as any)?.university_search?.[0] ?? "";

/** LinkedIn people searches the owner opens in their own browser: no API, no automation. */
export function searchLinks(company: string, region: string): Button[] {
  const school = college();
  const li = (kw: string) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
  return [
    { text: `🔎 ${company} engineers`, url: li(`${company} engineer ${region === "India" ? "" : region}`.trim()) },
    ...(school ? [{ text: "🎓 Alumni there", url: li(`${company} ${school}`) }] : []),
  ];
}

/** One Telegram message per job: who to ask, a ready-to-paste note, and a Sent button per person. */
export async function referralMessages(ctx: AgentContext, jobs: DigestJob[]): Promise<{ text: string; buttons: Button[][] }[]> {
  const out: { text: string; buttons: Button[][] }[] = [];
  const searched = new Set<string>();
  let searchDisabled = false;
  for (const j of jobs) {
    const region = regionOf(j.location);
    const key = companyKey(j.company_name);
    if (!searched.has(key)) {
      searched.add(key);
      try {
        searchDisabled = !(await refreshPeople(ctx, j.company_name, region));
      } catch (e) {
        ctx.log("people_search_error", { company: j.company_name, error: String(e) });
      }
    }
    const people = peopleFor(ctx, j.company_name);
    const lines = [`🤝 ${j.title} @ ${j.company_name}${j.location ? ` · ${j.location}` : ""}`, j.apply_url || j.url, ""];
    if (people.length) {
      for (const p of people)
        lines.push(`• ${p.name}${p.alumni ? " 🎓" : ""}${p.headline ? ` (${p.headline.slice(0, 70)})` : ""}${p.contactedAt ? ` (messaged ${new Date(p.contactedAt).toLocaleDateString("en-IN")})` : ""}`);
      lines.push("", "Note to paste (change the name for each person):", draftNote(j, people[0].name.split(/\s+/)[0]));
    } else {
      lines.push(searchDisabled ? "Use the LinkedIn search buttons below (add BRAVE_API_KEY to .env to list people automatically)." : "No one found by search; try the LinkedIn search buttons below.");
      lines.push("", "Note to paste:", draftNote(j, "there"));
    }
    const buttons: Button[][] = people.map((p) => [
      { text: `👤 ${p.name.split(/\s+/)[0]}`, url: p.url },
      { text: p.contactedAt ? "✅ Sent again" : "✅ Sent", data: `sent:${p.id}:${jobRef(ctx, j.id)}` },
    ]);
    buttons.push(searchLinks(j.company_name, region));
    out.push({ text: lines.join("\n"), buttons });
  }
  return out;
}

/** Telegram callback data is capped at 64 bytes, so jobs are referenced by rowid. */
function jobRef(ctx: AgentContext, jobId: string): number {
  return ctx.db.prepare("SELECT rowid FROM jobs WHERE id = ?").pluck().get(jobId) as number;
}

/** Handle "sent:<person>:<jobRowid>" and "followed:<person>:<jobRowid>" button taps. */
export async function onReferralCallback(ctx: AgentContext, data: string, reply: (t: string) => Promise<void>): Promise<boolean> {
  const m = data.match(/^(sent|followed):(\d+):(\d+)$/);
  if (!m) return false;
  const person = ctx.db.prepare("SELECT name FROM people WHERE id = ?").pluck().get(Number(m[2])) as string | undefined;
  const jobId = ctx.db.prepare("SELECT id FROM jobs WHERE rowid = ?").pluck().get(Number(m[3])) as string | undefined;
  if (!person || !jobId) return true;
  if (m[1] === "sent") {
    ctx.db.prepare("INSERT INTO outreach (person_id, job_id, sent_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET sent_at = excluded.sent_at").run(Number(m[2]), jobId, Date.now());
    await reply(`Noted: asked ${person}. I'll remind you to follow up in 5 days if needed.`);
  } else {
    ctx.db.prepare("UPDATE outreach SET followed_up_at = ? WHERE person_id = ? AND job_id = ?").run(Date.now(), Number(m[2]), jobId);
    await reply(`Noted: followed up with ${person}.`);
  }
  return true;
}

/** Asks sent FOLLOW_UP_AFTER ago with no follow-up yet. */
export function followUps(ctx: AgentContext): { text: string; buttons: Button[][] } | null {
  const rows = ctx.db
    .prepare(
      `SELECT o.person_id, j.rowid job_ref, p.name, p.url, j.title, j.company_name, o.sent_at FROM outreach o
       JOIN people p ON p.id = o.person_id JOIN jobs j ON j.id = o.job_id
       WHERE o.followed_up_at IS NULL AND o.sent_at <= ? ORDER BY o.sent_at LIMIT 10`,
    )
    .all(Date.now() - FOLLOW_UP_AFTER_MS) as any[];
  if (!rows.length) return null;
  return {
    text: ["⏰ Follow up on these referral asks (a short nudge is fine):", ...rows.map((r) => `• ${r.name}: ${r.title} @ ${r.company_name}, asked ${new Date(r.sent_at).toLocaleDateString("en-IN")}`)].join("\n"),
    buttons: rows.map((r) => [
      { text: `👤 ${r.name.split(/\s+/)[0]}`, url: r.url },
      { text: "✅ Followed up", data: `followed:${r.person_id}:${r.job_ref}` },
    ]),
  };
}
