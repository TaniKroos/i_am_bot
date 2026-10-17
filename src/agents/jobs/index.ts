import type { Agent, AgentContext } from "../../core/agent.js";
import { loadProfile } from "./profile.js";
import { resolveUrl } from "./resolve.js";
import { isLocationPlaceholder, scorePosting, screenPosting } from "./scorer.js";
import { fetchers } from "./sources/index.js";
import { TemporarilyUnavailable, type Ats, type Posting } from "./types.js";

/** Poll intervals by tier: hot companies every few minutes so we can apply early. */
export const POLL_EVERY_MS: Record<number, number> = { 1: 3 * 60_000, 2: 30 * 60_000 };
/** On a board's first poll, only postings this recent count as new. */
const FIRST_POLL_MAX_AGE_MS = 21 * 24 * 3600_000;
export const MATCH_THRESHOLD = 60;

/** Careers systems that can be found from a company name alone (Workday/Oracle need a URL). */
const NAME_RESOLVABLE: Ats[] = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"];

export function tokenCandidates(name: string): string[] {
  const base = name.toLowerCase().trim();
  return [...new Set([base.replace(/[^a-z0-9]/g, ""), base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")])].filter(Boolean);
}

function upsertPostings(ctx: AgentContext, postings: Posting[], firstPoll: boolean): Posting[] {
  const now = Date.now();
  const fresh: Posting[] = [];
  const exists = ctx.db.prepare("SELECT 1 FROM jobs WHERE id = ?").pluck();
  const insert = ctx.db.prepare(
    `INSERT INTO jobs (id, ats, board_token, company_name, external_id, title, location, remote, url, apply_url,
                       posted_at, first_seen_at, description, status, updated_at)
     VALUES (@id, @ats, @boardToken, @companyName, @externalId, @title, @location, @remote, @url, @applyUrl,
             @postedAt, @now, @description, @status, @now)`,
  );
  ctx.db.transaction(() => {
    for (const p of postings) {
      const id = jobId(p.ats, p.boardToken, p.externalId);
      if (exists.get(id)) continue;
      const stale = firstPoll && (p.postedAt === null || now - p.postedAt > FIRST_POLL_MAX_AGE_MS);
      insert.run({ ...p, id, remote: p.remote ? 1 : 0, now, status: stale ? "baseline" : "new" });
      if (!stale) fresh.push(p);
    }
  })();
  return fresh;
}

const jobId = (ats: string, token: string, externalId: string) => `${ats}:${token}:${externalId}`;

function addCompany(ctx: AgentContext, c: { ats: Ats; token: string; name: string; tier: number; source: string; jobCount?: number }) {
  ctx.db
    .prepare(
      `INSERT INTO companies (ats, token, name, tier, source, job_count, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ats, token) DO UPDATE SET tier = MIN(tier, excluded.tier), active = 1`,
    )
    .run(c.ats, c.token, c.name, c.tier, c.source, c.jobCount ?? null, Date.now());
  ctx.log("company_added", c);
}

function rowToPosting(row: any): Posting {
  return {
    ats: row.ats,
    boardToken: row.board_token,
    companyName: row.company_name,
    externalId: row.external_id,
    title: row.title,
    location: row.location ?? "",
    remote: !!row.remote,
    url: row.url,
    applyUrl: row.apply_url,
    postedAt: row.posted_at,
    description: row.description ?? "",
  };
}

export const jobsAgent: Agent = {
  id: "jobs",
  name: "Jobs",
  description: "Finds fresh roles that fit the owner's profile across company career sites, then tailors and applies.",
  migrations: [
    {
      id: "jobs:001",
      sql: `
        CREATE TABLE companies (
          ats TEXT NOT NULL,
          token TEXT NOT NULL,
          name TEXT NOT NULL,
          tier INTEGER NOT NULL DEFAULT 2,       -- 1 = hot (poll every few minutes), 2 = normal
          active INTEGER NOT NULL DEFAULT 1,
          source TEXT,                           -- how we learned about it: seed, x_post, alert_email, ...
          job_count INTEGER,
          last_polled_at INTEGER,
          last_error TEXT,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (ats, token)
        );
        CREATE TABLE unresolved_companies (
          name TEXT PRIMARY KEY,
          tried_at INTEGER NOT NULL,
          source TEXT
        );
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,                   -- ats:board:externalId
          ats TEXT NOT NULL,
          board_token TEXT NOT NULL,
          company_name TEXT NOT NULL,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL,
          location TEXT,
          remote INTEGER NOT NULL DEFAULT 0,
          url TEXT NOT NULL,
          apply_url TEXT NOT NULL,
          posted_at INTEGER,
          first_seen_at INTEGER NOT NULL,
          description TEXT,
          min_years INTEGER,
          score INTEGER,
          reasons TEXT,
          -- baseline | new | rejected | matched | tailoring | ready | applying | needs_user | submitted | failed
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX jobs_status ON jobs(status, score);
        CREATE INDEX jobs_company ON jobs(board_token, status);
      `,
    },
    {
      id: "jobs:002",
      sql: `
        -- Set once a board's first successful poll has stored its existing postings.
        ALTER TABLE companies ADD COLUMN baseline_done INTEGER NOT NULL DEFAULT 0;
        UPDATE companies SET baseline_done = 1 WHERE last_polled_at IS NOT NULL AND last_error IS NULL;
      `,
    },
  ],

  automations: [
    {
      id: "schedule-polls",
      everyMs: 30_000,
      run(ctx) {
        const now = Date.now();
        const due = ctx.db
          .prepare(
            `SELECT ats, token, tier FROM companies WHERE active = 1 AND
               (last_polled_at IS NULL OR last_polled_at + CASE tier WHEN 1 THEN ? ELSE ? END <= ?)`,
          )
          .all(POLL_EVERY_MS[1], POLL_EVERY_MS[2], now) as { ats: Ats; token: string; tier: number }[];
        for (const c of due) {
          ctx.enqueue("poll_board", { ats: c.ats, token: c.token }, { dedupeKey: `poll:${c.ats}:${c.token}`, priority: c.tier === 1 ? 5 : 0, maxAttempts: 1 });
        }
      },
    },
  ],

  concurrency: { poll_board: 8, resolve_company: 6, resolve_url: 4, score_job: 6 },

  handlers: {
    /** Find which careers system a company uses from its name (Greenhouse/Lever/Ashby/SmartRecruiters). */
    async resolve_company({ name, tier = 2, source = "manual" }: { name: string; tier?: number; source?: string }, ctx) {
      const probe = { isKnown: () => false, since: 0, firstPoll: false };
      for (const ats of NAME_RESOLVABLE) {
        for (const token of tokenCandidates(name)) {
          const board = await fetchers[ats].fetchBoard(token, probe).catch(() => null);
          if (!board) continue;
          addCompany(ctx, { ats, token, name, tier, source, jobCount: board.postings.length });
          return;
        }
      }
      ctx.db.prepare("INSERT OR REPLACE INTO unresolved_companies (name, tried_at, source) VALUES (?, ?, ?)").run(name, Date.now(), source);
    },

    /** Add a board from any job/careers URL (how Workday/Oracle companies, X posts and alert emails get in). */
    async resolve_url({ url, name, tier = 2, source = "manual" }: { url: string; name?: string; tier?: number; source?: string }, ctx) {
      const ref = await resolveUrl(url);
      if (!ref) {
        ctx.db.prepare("INSERT OR REPLACE INTO unresolved_companies (name, tried_at, source) VALUES (?, ?, ?)").run(name ?? url, Date.now(), source);
        return;
      }
      addCompany(ctx, { ...ref, name: name ?? ref.token.split("|")[0], tier, source });
    },

    async poll_board({ ats, token }: { ats: Ats; token: string }, ctx) {
      const company = ctx.db.prepare("SELECT name, baseline_done FROM companies WHERE ats = ? AND token = ?").get(ats, token) as
        | { name: string; baseline_done: number }
        | undefined;
      if (!company) return;
      const firstPoll = !company.baseline_done;
      const markPolled = (error: string | null, jobCount?: number) =>
        ctx.db
          .prepare(
            `UPDATE companies SET last_polled_at = ?, last_error = ?, job_count = COALESCE(?, job_count),
               baseline_done = baseline_done OR ? WHERE ats = ? AND token = ?`,
          )
          .run(Date.now(), error, jobCount ?? null, error ? 0 : 1, ats, token);
      const known = ctx.db.prepare("SELECT 1 FROM jobs WHERE id = ?").pluck();
      try {
        const board = await fetchers[ats].fetchBoard(token, {
          isKnown: (externalId) => Boolean(known.get(jobId(ats, token, externalId))),
          since: Date.now() - FIRST_POLL_MAX_AGE_MS,
          firstPoll,
        });
        if (!board) {
          ctx.db.prepare("UPDATE companies SET active = 0 WHERE ats = ? AND token = ?").run(ats, token);
          markPolled("board not found");
          return;
        }
        const fresh = upsertPostings(ctx, board.postings.map((p) => ({ ...p, companyName: company.name })), firstPoll);
        markPolled(null, board.postings.length);
        for (const p of fresh) ctx.enqueue("score_job", { id: jobId(p.ats, p.boardToken, p.externalId) }, { priority: 10 });
        if (fresh.length) ctx.log("new_postings", { ats, token, count: fresh.length });
      } catch (e) {
        // Maintenance windows (Workday weekends) are expected: note it and try again on the next cycle.
        markPolled(String(e));
        if (!(e instanceof TemporarilyUnavailable)) throw e;
      }
    },

    async score_job({ id }: { id: string }, ctx) {
      const row = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
      if (!row || row.status !== "new") return;
      const profile = loadProfile();
      let posting = rowToPosting(row);
      const save = (fields: Record<string, unknown>) => {
        const cols = Object.keys(fields);
        ctx.db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at = @now WHERE id = @id`).run({ ...fields, now: Date.now(), id });
      };

      // Big boards list without descriptions: screen on title/location first, fetch details only for survivors.
      const screened = screenPosting(posting, profile);
      if (screened) return save({ status: "rejected", score: 0, reasons: JSON.stringify([screened]) });
      const fetcher = fetchers[posting.ats];
      if ((!posting.description || isLocationPlaceholder(posting.location)) && fetcher.fetchDetails) {
        const details = await fetcher.fetchDetails(posting.boardToken, posting.externalId);
        posting = { ...posting, description: details.description, location: details.location ?? posting.location };
        save({ description: posting.description, location: posting.location });
      }

      const s = scorePosting(posting, profile);
      const matched = !s.rejected && s.score >= MATCH_THRESHOLD;
      const reasons = s.rejected ? [s.rejected] : matched ? s.reasons : [...s.reasons, `score ${s.score} < ${MATCH_THRESHOLD}`];
      save({ score: s.score, min_years: s.minYears, reasons: JSON.stringify(reasons), status: matched ? "matched" : "rejected" });
      if (matched) {
        ctx.notify(`New match (${s.score}): ${row.title} @ ${row.company_name} — ${posting.location}`, { id, url: row.url });
        // Next stage (tailor resume → fill → submit) plugs in here.
      }
    },
  },
};
