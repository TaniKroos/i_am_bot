import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "../../core/agent.js";
import { notifyOwner, notifyOwnerFile } from "../../core/channels/telegram.js";
import { DATA_DIR } from "../../core/config.js";
import { Deferred } from "../../core/runtime.js";
import { loadAnswerBank } from "./apply/answers.js";
import { botBrowser } from "./apply/browser.js";
import { fillGreenhouse } from "./apply/greenhouse-fill.js";
import { submitGreenhouse } from "./apply/greenhouse-submit.js";
import { planApplication, recordPendingQuestions } from "./apply/plan.js";
import { loadProfile } from "./profile.js";
import { tailorResume, type TailorOutcome } from "./tailor.js";
import { pickResume } from "./variants.js";

/** Tailor only when the best ready-made resume under-sells the owner by this much, and the job is worth it. */
export const TAILOR_GAP = 0.2;
export const TAILOR_MIN_SCORE = 80;
export const OPUS_MIN_SCORE = 95;

/**
 * Matched job → tailored resume → filled form → submitted, with no approval step.
 * Every gate that fails sends the job to the owner on Telegram instead of submitting.
 */

/** Careers systems the bot can fill and submit today. Other matches wait for their adapter. */
export const SUBMITTABLE = new Set(["greenhouse"]);

export const SETTINGS_DEFAULTS = { daily_cap: 60, company_cap: 2, company_window_days: 30, dry_run: 0, paused: 0 };
type Settings = typeof SETTINGS_DEFAULTS;

export function settings(ctx: AgentContext): Settings {
  const rows = ctx.db.prepare("SELECT key, value FROM kv WHERE agent = 'jobs' AND key LIKE 'setting:%'").all() as { key: string; value: string }[];
  const s = { ...SETTINGS_DEFAULTS };
  for (const r of rows) (s as any)[r.key.slice(8)] = Number(r.value);
  return s;
}

export function setSetting(ctx: AgentContext, key: keyof Settings, value: number): void {
  ctx.db
    .prepare("INSERT INTO kv (agent, key, value) VALUES ('jobs', ?, ?) ON CONFLICT(agent, key) DO UPDATE SET value = excluded.value")
    .run(`setting:${key}`, String(value));
}

/** Paused / capped / usage-limited: try again later without spending an attempt. */
const RetryLater = (reason: string, minutes = 15) => new Deferred(reason, minutes * 60_000);

function app(ctx: AgentContext, jobId: string): any {
  return ctx.db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
}

function setApp(ctx: AgentContext, jobId: string, fields: Record<string, unknown>): void {
  const now = Date.now();
  ctx.db.prepare("INSERT INTO applications (job_id, status, created_at, updated_at) VALUES (?, 'queued', ?, ?) ON CONFLICT(job_id) DO NOTHING").run(jobId, now, now);
  const cols = Object.keys(fields);
  ctx.db
    .prepare(`UPDATE applications SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at = @now WHERE job_id = @jobId`)
    .run({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : v])), now, jobId });
  if (fields.status) ctx.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(fields.status, now, jobId);
}

async function needsUser(ctx: AgentContext, jobId: string, job: any, reason: string, screenshot?: string): Promise<void> {
  setApp(ctx, jobId, { status: "needs_user", error: reason });
  const text = `🔔 Needs you: ${job.title} @ ${job.company_name}\n${reason}\n${job.url}`;
  try {
    if (screenshot) await notifyOwnerFile(screenshot, text);
    else await notifyOwner(text);
  } catch (e) {
    ctx.log("telegram_error", { error: String(e) });
  }
}

function capsReached(ctx: AgentContext, job: any): string | null {
  const s = settings(ctx);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = ctx.db.prepare("SELECT COUNT(*) FROM applications WHERE status = 'submitted' AND submitted_at >= ?").pluck().get(dayStart) as number;
  if (today >= s.daily_cap) return `daily cap ${s.daily_cap} reached`;
  const since = Date.now() - s.company_window_days * 86_400_000;
  const atCompany = ctx.db
    .prepare(
      `SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE j.company_name = ? AND a.status IN ('submitted', 'submitting') AND a.updated_at >= ?`,
    )
    .pluck()
    .get(job.company_name, since) as number;
  if (atCompany >= s.company_cap) return `already ${atCompany} applications at ${job.company_name} in ${s.company_window_days} days`;
  return null;
}

/** Plan answers, tailor the resume, run the truth check. Ends in ready (→ submit), needs_user or skipped. */
export async function prepareApplication({ jobId }: { jobId: string }, ctx: AgentContext): Promise<void> {
  const s = settings(ctx);
  if (s.paused) throw RetryLater("paused", 5);
  const job = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!job || ["submitted", "submitting", "needs_user", "skipped"].includes(app(ctx, jobId)?.status)) return;
  if (!SUBMITTABLE.has(job.ats)) return setApp(ctx, jobId, { status: "waiting_adapter", error: `${job.ats} filler not built yet` });
  const cap = capsReached(ctx, job);
  if (cap?.includes("already")) return setApp(ctx, jobId, { status: "skipped", error: cap });

  // 1) Can every required question be answered? (resume path is a placeholder at this stage)
  const plan = await planApplication(ctx.db, jobId, "<resume>");
  if (plan.blockers.length) {
    recordPendingQuestions(plan.blockers.map((question) => ({ question, company: job.company_name, title: job.title })));
    setApp(ctx, jobId, { blockers: plan.blockers });
    return needsUser(ctx, jobId, job, `Questions only you can answer:\n• ${plan.blockers.join("\n• ")}\nReply with answers and I'll add them to your answer bank.`);
  }

  // 2) Resume, cheapest first. Tier 0: best ready-made resume (no Claude usage).
  const choice = pickResume(`${job.title}\n${job.description ?? ""}`);
  const useReady = async (why: string) => {
    const dir = join(DATA_DIR, "applications", `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${job.company_name.replace(/\W+/g, "_")}-${job.external_id}`);
    mkdirSync(dir, { recursive: true });
    const pdf = join(dir, `Tanish_Saini_${job.company_name.replace(/\W+/g, "_")}_Resume.pdf`);
    copyFileSync(choice.pdf, pdf);
    setApp(ctx, jobId, { dir, resume_pdf: pdf, resume_verdict: "ready", resume_tier: 0, resume_variant: choice.name, resume_gap: choice.gap.gap, error: why });
  };

  if (choice.gap.gap < TAILOR_GAP || (job.score ?? 0) < TAILOR_MIN_SCORE) {
    await useReady(`tier 0: ${choice.name} (gap ${(choice.gap.gap * 100).toFixed(0)}%)`);
  } else {
    // Tier 1 (Sonnet) or tier 2 (Opus for top matches); one redo without flagged terms, then Opus, then fall back to tier 0.
    setApp(ctx, jobId, { status: "tailoring" });
    const attempt = async (model: string, banned?: string[]): Promise<TailorOutcome | "limit"> => {
      const out = await tailorResume(ctx.db, jobId, { model, bannedTerms: banned });
      return !out.run.ok && /limit|quota|rate/i.test(`${out.run.error} ${out.run.result}`) ? "limit" : out;
    };
    const first = (job.score ?? 0) >= OPUS_MIN_SCORE ? "opus" : "sonnet";
    let out = await attempt(first);
    if (out !== "limit" && out.verdict === "review") out = await attempt(first, out.truth?.borrowedTerms);
    if (out !== "limit" && out.verdict !== "ready" && first === "sonnet") out = await attempt("opus");
    if (out !== "limit" && out.verdict === "ready") {
      setApp(ctx, jobId, { dir: out.dir, resume_pdf: out.pdf, resume_verdict: "ready", resume_tier: first === "opus" ? 2 : 1, resume_gap: choice.gap.gap, truth: out.truth });
    } else {
      await useReady(out === "limit" ? "Claude usage limit: used ready-made resume" : `tailoring failed truth check (${JSON.stringify(out.truth)}): used ready-made resume`);
    }
  }
  setApp(ctx, jobId, { status: "ready" });
  ctx.enqueue("submit_application", { jobId }, { priority: 20, dedupeKey: `submit:${jobId}`, maxAttempts: 1 });
}

/** Fill, verify, submit, confirm. Never retried automatically after Submit is clicked (no double applications). */
export async function submitApplication({ jobId }: { jobId: string }, ctx: AgentContext): Promise<void> {
  const s = settings(ctx);
  if (s.paused) throw RetryLater("paused", 5);
  const job = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  const a = app(ctx, jobId);
  if (!job || a?.status !== "ready") return;
  const cap = capsReached(ctx, job);
  if (cap) throw RetryLater(cap, 60);

  const profile = loadProfile();
  const plan = await planApplication(ctx.db, jobId, a.resume_pdf);
  if (plan.blockers.length) return needsUser(ctx, jobId, job, `New required questions:\n• ${plan.blockers.join("\n• ")}`);

  const dir = a.dir ?? join(DATA_DIR, "applications", jobId.replace(/\W+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const browser = await botBrowser();
  const page = await browser.newPage();
  try {
    const report = await fillGreenhouse(
      page,
      { boardToken: job.board_token, externalId: job.external_id },
      plan,
      { city: profile.identity.city, country: profile.identity.country, phone: profile.identity.phone.replace(/[^\d+]/g, "") },
      { profile, bank: loadAnswerBank(), job: { company: job.company_name, title: job.title, location: job.location ?? "" }, resumePdf: a.resume_pdf },
      join(dir, "filled.png"),
    );
    writeFileSync(join(dir, "answers.json"), JSON.stringify(report, null, 2));
    setApp(ctx, jobId, { fill: { filled: report.filled.length, failed: report.failed, captcha: report.captcha } });
    if (report.failed.length) return needsUser(ctx, jobId, job, `Couldn't fill: ${report.failed.map((f) => `${f.label} (${f.error})`).join("; ")}`, report.screenshot);
    if (report.captcha === "challenge") return needsUser(ctx, jobId, job, "🧩 CAPTCHA challenge before submit", report.screenshot);
    if (s.dry_run) return setApp(ctx, jobId, { status: "ready", error: "dry run: filled, not submitted" });

    setApp(ctx, jobId, { status: "submitting" });
    const outcome = await submitGreenhouse(page, join(dir, "after-submit.png"));
    setApp(ctx, jobId, { outcome });
    if (outcome.kind === "submitted") {
      setApp(ctx, jobId, { status: "submitted", submitted_at: Date.now() });
      ctx.log("submitted", { jobId, company: job.company_name, title: job.title });
      await notifyOwnerFile(join(dir, "after-submit.png"), `✅ Applied: ${job.title} @ ${job.company_name}\n${job.url}`).catch(() => undefined);
    } else if (outcome.kind === "captcha") {
      await needsUser(ctx, jobId, job, "🧩 CAPTCHA appeared on submit. Open the link to apply yourself, or wait for the live browser view.", join(dir, "after-submit.png"));
    } else if (outcome.kind === "invalid") {
      await needsUser(ctx, jobId, job, `The form rejected: ${outcome.errors.join("; ")}`, join(dir, "after-submit.png"));
    } else {
      await needsUser(ctx, jobId, job, `Clicked Submit but couldn't confirm it went through (${outcome.detail}). Check your email before re-applying.`, join(dir, "after-submit.png"));
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

