import type { Agent, AgentContext } from "../../core/agent.js";
import { loadProfile } from "./profile.js";
import { scorePosting } from "./scorer.js";
import { fetchers } from "./sources/index.js";
import type { Ats, Posting } from "./types.js";

/** Poll intervals by tier: hot companies every few minutes so we can apply early. */
export const POLL_EVERY_MS: Record<number, number> = { 1: 3 * 60_000, 2: 30 * 60_000 };
/** On a board's first poll, only postings this recent count as new. */
const FIRST_POLL_MAX_AGE_MS = 21 * 24 * 3600_000;
export const MATCH_THRESHOLD = 60;

const ATS_ORDER: Ats[] = ["greenhouse", "lever", "ashby"];

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
      const id = `${p.ats}:${p.boardToken}:${p.externalId}`;
      if (exists.get(id)) continue;
      const stale = firstPoll && (p.postedAt === null || now - p.postedAt > FIRST_POLL_MAX_AGE_MS);
      insert.run({ ...p, id, remote: p.remote ? 1 : 0, now, status: stale ? "baseline" : "new" });
      if (!stale) fresh.push(p);
    }
  })();
  return fresh;
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

  concurrency: { poll_board: 8, resolve_company: 4, score_job: 4 },

  handlers: {
    /** Find which careers system a company uses and add it to the directory. */
    async resolve_company({ name, tier = 2, source = "manual" }: { name: string; tier?: number; source?: string }, ctx) {
      for (const ats of ATS_ORDER) {
        for (const token of tokenCandidates(name)) {
          const board = await fetchers[ats].fetchBoard(token).catch(() => null);
          if (!board) continue;
          ctx.db
            .prepare(
              `INSERT INTO companies (ats, token, name, tier, source, job_count, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(ats, token) DO UPDATE SET tier = MIN(tier, excluded.tier)`,
            )
            .run(ats, token, board.companyName === token ? name : board.companyName, tier, source, board.postings.length, Date.now());
          ctx.log("company_added", { name, ats, token, jobs: board.postings.length });
          return;
        }
      }
      ctx.db.prepare("INSERT OR REPLACE INTO unresolved_companies (name, tried_at, source) VALUES (?, ?, ?)").run(name, Date.now(), source);
    },

    async poll_board({ ats, token }: { ats: Ats; token: string }, ctx) {
      const firstPoll = !ctx.db.prepare("SELECT last_polled_at FROM companies WHERE ats = ? AND token = ?").pluck().get(ats, token);
      const markPolled = (error: string | null, jobCount?: number) =>
        ctx.db
          .prepare("UPDATE companies SET last_polled_at = ?, last_error = ?, job_count = COALESCE(?, job_count) WHERE ats = ? AND token = ?")
          .run(Date.now(), error, jobCount ?? null, ats, token);
      try {
        const board = await fetchers[ats].fetchBoard(token);
        if (!board) {
          ctx.db.prepare("UPDATE companies SET active = 0 WHERE ats = ? AND token = ?").run(ats, token);
          markPolled("board not found");
          return;
        }
        const name = ctx.db.prepare("SELECT name FROM companies WHERE ats = ? AND token = ?").pluck().get(ats, token) as string;
        const fresh = upsertPostings(ctx, board.postings.map((p) => ({ ...p, companyName: name ?? p.companyName })), firstPoll);
        markPolled(null, board.postings.length);
        for (const p of fresh) {
          ctx.enqueue("score_job", { id: `${p.ats}:${p.boardToken}:${p.externalId}` }, { priority: 10 });
        }
        if (fresh.length) ctx.log("new_postings", { ats, token, count: fresh.length });
      } catch (e) {
        markPolled(String(e));
        throw e;
      }
    },

    async score_job({ id }: { id: string }, ctx) {
      const row = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
      if (!row || row.status !== "new") return;
      const posting: Posting = {
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
      const s = scorePosting(posting, loadProfile());
      const status = s.rejected ? "rejected" : s.score >= MATCH_THRESHOLD ? "matched" : "rejected";
      const reasons = s.rejected ? [s.rejected] : s.score >= MATCH_THRESHOLD ? s.reasons : [...s.reasons, `score ${s.score} < ${MATCH_THRESHOLD}`];
      ctx.db
        .prepare("UPDATE jobs SET score = ?, min_years = ?, reasons = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(s.score, s.minYears, JSON.stringify(reasons), status, Date.now(), id);
      if (status === "matched") {
        ctx.notify(`New match (${s.score}): ${row.title} @ ${row.company_name} — ${row.location}`, { id, url: row.url });
        // Next stage (tailor resume → fill → submit) plugs in here.
      }
    },
  },
};
