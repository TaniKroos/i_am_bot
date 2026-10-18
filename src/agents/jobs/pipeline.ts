import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "../../core/agent.js";
import { notifyOwner, notifyOwnerFile } from "../../core/channels/telegram.js";
import { DATA_DIR } from "../../core/config.js";
import { Deferred } from "../../core/runtime.js";
import { loadAnswerBank } from "./apply/answers.js";
import { botBrowser } from "./apply/browser.js";
import { fillGreenhouse } from "./apply/greenhouse-fill.js";
import { submitGreenhouse, type CodeSource, type SubmitOutcome } from "./apply/greenhouse-submit.js";
import { applyWorkday } from "./apply/workday-run.js";
import { waitForMail } from "../../core/google/gmail.js";
import { planApplication, recordPendingQuestions } from "./apply/plan.js";
import { composeAnswers, type Composed } from "./apply/compose.js";
import { loadProfile } from "./profile.js";
import { tailorResume, type TailorOutcome } from "./tailor.js";
import { pickResume } from "./variants.js";
import { alreadyApplied, appliedAtCompany, recordApplied } from "./applied.js";

/** Tailor only when the best ready-made resume under-sells the owner by this much, and the job is worth it. */
export const TAILOR_GAP = 0.2;
export const TAILOR_MIN_SCORE = 80;
export const OPUS_MIN_SCORE = 95;

/**
 * Matched job → tailored resume → filled form → submitted, with no approval step.
 * Every gate that fails sends the job to the owner on Telegram instead of submitting.
 */

/** Careers systems the bot can fill and submit today. Other matches wait for their adapter. */
export const SUBMITTABLE = new Set(["greenhouse", "workday"]);

/** find_only: discover and score (no Claude usage), send a daily digest at digest_hour, never prepare or apply. */
export const SETTINGS_DEFAULTS = { daily_cap: 60, company_cap: 2, company_window_days: 30, dry_run: 0, paused: 0, find_only: 1, digest_hour: 20 };
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
  // Ledger = bot submissions + applications found in Gmail; plus anything mid-submit right now.
  const inFlight = ctx.db
    .prepare(`SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.company_name = ? AND a.status = 'submitting'`)
    .pluck()
    .get(job.company_name) as number;
  const atCompany = appliedAtCompany(ctx.db, job.company_name, since) + inFlight;
  if (atCompany >= s.company_cap) return `already ${atCompany} applications at ${job.company_name} in ${s.company_window_days} days`;
  return null;
}

/** For "active application with us?" / "declined in the last 6 months?" questions. */
function companyHistory(ctx: AgentContext, job: any): { companyApplications180d: number } {
  return { companyApplications180d: appliedAtCompany(ctx.db, job.company_name, Date.now() - 180 * 86_400_000) };
}

/** Plan answers, tailor the resume, run the truth check. Ends in ready (→ submit), needs_user or skipped. */
export async function prepareApplication({ jobId }: { jobId: string }, ctx: AgentContext): Promise<void> {
  const s = settings(ctx);
  if (s.paused) throw RetryLater("paused", 5);
  if (s.find_only) throw RetryLater("find-only mode", 60);
  const job = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  const existing = app(ctx, jobId);
  if (!job || ["submitted", "submitting", "needs_user", "skipped"].includes(existing?.status)) return;
  // Already has a checked resume (dry run, or prepared before a rescore): go straight to submitting.
  if (["dry_run", "ready"].includes(existing?.status) && existing.resume_pdf && existing.resume_verdict === "ready" && !s.dry_run) {
    setApp(ctx, jobId, { status: "ready", error: null });
    ctx.enqueue("submit_application", { jobId }, { priority: 20, dedupeKey: `submit:${jobId}`, maxAttempts: 1 });
    return;
  }
  const dup = alreadyApplied(ctx.db, job);
  if (dup) return setApp(ctx, jobId, { status: "skipped", error: dup });
  if (!SUBMITTABLE.has(job.ats)) return setApp(ctx, jobId, { status: "waiting_adapter", error: `${job.ats} filler not built yet` });
  const cap = capsReached(ctx, job);
  if (cap?.includes("already")) return setApp(ctx, jobId, { status: "skipped", error: cap });

  // 1) Can every required question be answered? (resume path is a placeholder at this stage)
  // Workday shows its questions only after sign-in, so they are answered step by step at submit time.
  let plan = job.ats === "greenhouse" ? await planApplication(ctx.db, jobId, "<resume>") : { jobId, fields: [], blockers: [] as string[] };
  let composed: Composed | undefined;
  if (plan.blockers.length) {
    // Questions about the owner's experience: written from profile/experience.md and truth-checked.
    const open = plan.fields.filter((p) => p.answer.kind === "ask" && p.field.group !== "eeoc").map((p) => p.field);
    composed = await composeAnswers(job, open);
    setApp(ctx, jobId, { composed });
    plan = await planApplication(ctx.db, jobId, "<resume>", composed.values);
  }
  if (plan.blockers.length) {
    recordPendingQuestions(plan.blockers.map((question) => ({ question, company: job.company_name, title: job.title })));
    setApp(ctx, jobId, { blockers: plan.blockers });
    const why = new Map((composed?.rejected ?? []).map((r) => [r.question, r.reason]));
    const lines = plan.blockers.map((q) => (why.has(q) ? `${q}\n   ↳ ${why.get(q)}` : q));
    return needsUser(ctx, jobId, job, `Questions only you can answer:\n• ${lines.join("\n• ")}\nAdd facts to profile/experience.md or answers to profile/answers.yaml.`);
  }

  // 2) Resume, cheapest first. Tier 0: best ready-made resume (no Claude usage).
  const choice = pickResume(`${job.title}\n${job.description ?? ""}`);
  const useReady = async (why: string) => {
    const dir = join(DATA_DIR, "applications", `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${job.company_name.replace(/\W+/g, "_")}-${String(job.external_id).replace(/\W+/g, "_").slice(-60)}`);
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

/** Greenhouse emails an 8-character security code ("Security code for your application to <Company>"). */
function greenhouseCode(company: string): CodeSource {
  const first = company.toLowerCase().split(/\s+/)[0];
  return async (since) => {
    const found = await waitForMail({
      query: 'from:greenhouse-mail.io subject:"security code"',
      since,
      timeoutMs: 180_000,
      extract: (m) => {
        // Submissions run one at a time, but still prefer the email that names this company.
        if (first && !m.subject.toLowerCase().includes(first)) return null;
        return m.text.match(/application:\s*([A-Za-z0-9]{6,12})\b/)?.[1] ?? null;
      },
    });
    return found?.value ?? null;
  };
}

/** Fill, verify, submit, confirm. Never retried automatically after Submit is clicked (no double applications). */
export async function submitApplication({ jobId }: { jobId: string }, ctx: AgentContext): Promise<void> {
  const s = settings(ctx);
  if (s.paused) throw RetryLater("paused", 5);
  if (s.find_only) throw RetryLater("find-only mode", 60);
  const job = ctx.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  const a = app(ctx, jobId);
  if (!job || a?.status !== "ready") return;
  const dup = alreadyApplied(ctx.db, job);
  if (dup) return setApp(ctx, jobId, { status: "skipped", error: dup });
  const cap = capsReached(ctx, job);
  if (cap?.includes("already")) return setApp(ctx, jobId, { status: "skipped", error: cap });
  if (cap) throw RetryLater(cap, 60);

  if (!SUBMITTABLE.has(job.ats)) return setApp(ctx, jobId, { status: "waiting_adapter", error: `${job.ats} submission switched off` });
  if (job.ats === "workday") return submitWorkdayApplication(ctx, jobId, job, a, Boolean(s.dry_run));

  const profile = loadProfile();
  const composed: Composed | null = a.composed ? JSON.parse(a.composed) : null;
  const plan = await planApplication(ctx.db, jobId, a.resume_pdf, composed?.values);
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
      { city: profile.identity.city, country: profile.identity.country, phone: profile.identity.phone },
      { profile, bank: loadAnswerBank(), job: { company: job.company_name, title: job.title, location: job.location ?? "" }, resumePdf: a.resume_pdf, history: companyHistory(ctx, job) },
      join(dir, "filled.png"),
    );
    writeFileSync(join(dir, "answers.json"), JSON.stringify(report, null, 2));
    setApp(ctx, jobId, { fill: { filled: report.filled.length, failed: report.failed, captcha: report.captcha } });
    if (report.failed.length) return needsUser(ctx, jobId, job, `Couldn't fill: ${report.failed.map((f) => `${f.label} (${f.error})`).join("; ")}`, report.screenshot);
    if (report.captcha === "challenge") return needsUser(ctx, jobId, job, "🧩 CAPTCHA challenge before submit", report.screenshot);
    // Dry run: remember the work (resume, plan) but leave the job eligible for a real application later.
    if (s.dry_run) {
      setApp(ctx, jobId, { status: "dry_run", error: "dry run: filled, not submitted" });
      ctx.db.prepare("UPDATE jobs SET status = 'matched' WHERE id = ?").run(jobId);
      return;
    }

    setApp(ctx, jobId, { status: "submitting" });
    const outcome = await submitGreenhouse(page, join(dir, "after-submit.png"), greenhouseCode(job.company_name));
    await handleOutcome(ctx, jobId, job, join(dir, "after-submit.png"), outcome, composed);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Record what happened after Submit was clicked. Only a code timeout (never submitted) is retried. */
async function handleOutcome(ctx: AgentContext, jobId: string, job: any, screenshot: string, outcome: SubmitOutcome, composed: Pick<Composed, "log"> | null): Promise<void> {
  setApp(ctx, jobId, { outcome });
  if (outcome.kind === "submitted") {
    setApp(ctx, jobId, { status: "submitted", submitted_at: Date.now() });
    recordApplied(ctx.db, { jobId, company: job.company_name, title: job.title, source: "bot", appliedAt: Date.now(), ref: jobId });
    ctx.log("submitted", { jobId, company: job.company_name, title: job.title });
    const wrote = composed?.log.length ? `\n✍️ ${composed.log.length} written answer(s) from your experience file:\n${composed.log.map((l) => `• ${l.question.slice(0, 80)}\n  → ${l.answer.slice(0, 300)}`).join("\n")}` : "";
    await notifyOwnerFile(screenshot, `✅ Applied: ${job.title} @ ${job.company_name}\n${job.url}${wrote}`.slice(0, 1000)).catch(() => undefined);
  } else if (outcome.kind === "captcha") {
    await needsUser(ctx, jobId, job, "🧩 CAPTCHA appeared on submit. Open the link to apply yourself, or wait for the live browser view.", screenshot);
  } else if (outcome.kind === "code_timeout") {
    // Not submitted: the code step never completed, so it is safe to retry later.
    setApp(ctx, jobId, { status: "ready", error: outcome.detail });
    throw RetryLater(`security code: ${outcome.detail}`, 20);
  } else if (outcome.kind === "invalid") {
    await needsUser(ctx, jobId, job, `The form rejected: ${outcome.errors.join("; ")}`, screenshot);
  } else {
    await needsUser(ctx, jobId, job, `Clicked Submit but couldn't confirm it went through (${outcome.detail}). Check your email before re-applying.`, screenshot);
  }
}

/** Workday: sign in (Google / Keychain password / new account), fill each step, then submit from Review. */
async function submitWorkdayApplication(ctx: AgentContext, jobId: string, job: any, a: any, dryRun: boolean): Promise<void> {
  const profile = loadProfile();
  const dir = a.dir ?? join(DATA_DIR, "applications", jobId.replace(/\W+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const answerCtx = { profile, bank: loadAnswerBank(), job: { company: job.company_name, title: job.title, location: job.location ?? "" }, resumePdf: a.resume_pdf, history: companyHistory(ctx, job) };
  const log: Composed["log"] = [];
  const browser = await botBrowser();
  const page = await browser.newPage();
  try {
    // "applying" while filling (safe to retry after a crash); "submitting" only once Submit is about to be clicked.
    setApp(ctx, jobId, { status: "applying" });
    const r = await applyWorkday(page, job.url, answerCtx, {
      // (errors thrown while filling are caught below: nothing was submitted)
      submit: !dryRun,
      dir,
      email: profile.identity.email,
      nationalPhone: String(profile.identity.phone).replace(/^\+\d{1,3}[\s-]/, "").replace(/\D/g, ""),
      beforeSubmit: () => setApp(ctx, jobId, { status: "submitting" }),
      compose: async (fields) => {
        const c = await composeAnswers(job, fields.filter((f) => f.group !== "eeoc"), dir);
        log.push(...c.log);
        setApp(ctx, jobId, { composed: { values: c.values, log, rejected: c.rejected } });
        return c;
      },
    }).catch(async (e) => {
      if (app(ctx, jobId)?.status === "submitting") throw e; // Submit may have been clicked: handled as interrupted
      return { kind: "needs_user" as const, reason: `stopped while filling: ${String(e).split("\n")[0].slice(0, 200)}`, screenshot: await page.screenshot({ path: join(dir, "error.png"), fullPage: true }).then(() => join(dir, "error.png")).catch(() => "") };
    });
    if (r.kind === "already_applied") {
      recordApplied(ctx.db, { jobId, company: job.company_name, title: job.title, source: "workday", appliedAt: Date.now(), ref: jobId });
      return setApp(ctx, jobId, { status: "skipped", error: "Workday says you already applied" });
    }
    // Nothing was submitted in these cases: the application stays a draft on Workday.
    if (r.kind === "needs_user") return needsUser(ctx, jobId, job, r.reason, r.screenshot);
    if (r.kind === "dry_run") {
      setApp(ctx, jobId, { status: "dry_run", error: "dry run: filled to Review, not submitted" });
      ctx.db.prepare("UPDATE jobs SET status = 'matched' WHERE id = ?").run(jobId);
      return;
    }
    await handleOutcome(ctx, jobId, job, r.screenshot, r.outcome, { log });
  } finally {
    await page.close().catch(() => undefined);
  }
}

