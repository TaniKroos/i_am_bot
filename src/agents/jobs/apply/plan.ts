import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { PROFILE_DIR } from "../../../core/config.js";
import type { DB } from "../../../core/db.js";
import { loadProfile } from "../profile.js";
import { answerField, loadAnswerBank } from "./answers.js";
import { greenhouseForm } from "./greenhouse.js";
import { appliedAtCompany } from "../applied.js";
import type { ApplicationPlan, FormField } from "./types.js";

const PENDING = join(PROFILE_DIR, "questions-pending.yaml");

async function formFor(job: any): Promise<FormField[]> {
  if (job.ats === "greenhouse") return greenhouseForm(job.board_token, job.external_id);
  throw new Error(`form reader for ${job.ats} not built yet`);
}

/** `composed`: answers the composer wrote for questions the rules couldn't answer (field key → value). */
export async function planApplication(db: DB, jobId: string, resumePdf: string | null, composed: Record<string, string | string[]> = {}): Promise<ApplicationPlan> {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  const fields = await formFor(job);
  const ctx = {
    profile: loadProfile(),
    bank: loadAnswerBank(),
    job: { company: job.company_name, title: job.title, location: job.location ?? "" },
    resumePdf,
    history: { companyApplications180d: appliedAtCompany(db, job.company_name, Date.now() - 180 * 86_400_000) },
  };
  const planned = fields.map((field) => {
    const answer = answerField(field, ctx);
    return answer.kind === "ask" && composed[field.key] !== undefined
      ? { field, answer: { kind: "value" as const, value: composed[field.key], source: "composed" as const } }
      : { field, answer };
  });
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
