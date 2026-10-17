import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { PROFILE_DIR } from "../../../core/config.js";
import type { DB } from "../../../core/db.js";
import { loadProfile } from "../profile.js";
import { answerField, loadAnswerBank } from "./answers.js";
import { greenhouseForm } from "./greenhouse.js";
import type { ApplicationPlan, FormField } from "./types.js";

const PENDING = join(PROFILE_DIR, "questions-pending.yaml");

async function formFor(job: any): Promise<FormField[]> {
  if (job.ats === "greenhouse") return greenhouseForm(job.board_token, job.external_id);
  throw new Error(`form reader for ${job.ats} not built yet`);
}

export async function planApplication(db: DB, jobId: string, resumePdf: string | null): Promise<ApplicationPlan> {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  const fields = await formFor(job);
  const ctx = {
    profile: loadProfile(),
    bank: loadAnswerBank(),
    job: { company: job.company_name, title: job.title, location: job.location ?? "" },
    resumePdf,
  };
  const planned = fields.map((field) => ({ field, answer: answerField(field, ctx) }));
  const blockers = planned.flatMap((p) => (p.answer.kind === "ask" ? [p.answer.question] : []));
  return { jobId, fields: planned, blockers };
}

/** Questions only the owner can answer, deduplicated across jobs, for profile/questions-pending.yaml. */
export function recordPendingQuestions(items: { question: string; company: string; title: string }[], opts: { replace?: boolean } = {}): number {
  const existing: { question: string; seen_in: string[] }[] =
    !opts.replace && existsSync(PENDING) ? (YAML.parse(readFileSync(PENDING, "utf8"))?.pending ?? []) : [];
  const key = (q: string) => q.toLowerCase().replace(/\(.*$/, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
  const byKey = new Map(existing.map((e) => [key(e.question), e]));
  for (const it of items) {
    const k = key(it.question);
    const where = `${it.company}: ${it.title}`;
    const e = byKey.get(k) ?? { question: it.question, seen_in: [] };
    if (!e.seen_in.includes(where)) e.seen_in.push(where);
    byKey.set(k, e);
  }
  const pending = [...byKey.values()].sort((a, b) => b.seen_in.length - a.seen_in.length);
  writeFileSync(
    PENDING,
    "# Questions the bot couldn't answer. Add your answer to profile/answers.yaml (match: a regex for the question, answer: ...).\n" +
      YAML.stringify({ pending }),
  );
  return pending.length;
}
