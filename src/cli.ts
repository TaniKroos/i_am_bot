import { getDb } from "./core/db.js";
import { Runtime } from "./core/runtime.js";
import { jobsAgent } from "./agents/jobs/index.js";
import { SEED_TIER1, SEED_TIER2, SEED_URLS } from "./agents/jobs/seed.js";

const runtime = new Runtime();
runtime.register(jobsAgent);
const ctx = runtime.context("jobs");
const db = getDb();

const [cmd, ...args] = process.argv.slice(2);

const ago = (ms: number | null) => {
  if (!ms) return "?";
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

switch (cmd) {
  case "seed": {
    for (const s of SEED_URLS) ctx.enqueue("resolve_url", { url: s.url, name: s.name, tier: s.tier ?? 2, source: "seed" }, { dedupeKey: `resolve_url:${s.url}` });
    const tier1 = new Set(SEED_TIER1);
    const resolved = new Set(db.prepare("SELECT name FROM companies").pluck().all() as string[]);
    for (const name of new Set([...SEED_TIER1, ...SEED_TIER2].filter((n) => !resolved.has(n)))) {
      ctx.enqueue("resolve_company", { name, tier: tier1.has(name) ? 1 : 2, source: "seed" }, { dedupeKey: `resolve:${name}` });
    }
    await runtime.drain();
    const n = db.prepare("SELECT ats, COUNT(*) n, SUM(tier = 1) hot FROM companies WHERE active = 1 GROUP BY ats").all();
    const total = db.prepare("SELECT COUNT(*) FROM companies WHERE active = 1").pluck().get();
    const u = db.prepare("SELECT COUNT(*) FROM unresolved_companies WHERE name NOT IN (SELECT name FROM companies)").pluck().get();
    console.table(n);
    console.log(`total active companies: ${total} | unresolved names: ${u}`);
    break;
  }
  case "add-url": {
    // e.g. add-url https://acme.wd5.myworkdayjobs.com/External --name "Acme" --hot
    const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : undefined;
    const tier = args.includes("--hot") ? 1 : 2;
    for (const url of args.filter((a) => /^https?:\/\//.test(a))) ctx.enqueue("resolve_url", { url, name, tier, source: "manual" });
    await runtime.drain();
    break;
  }
  case "add-company": {
    const tier = args.includes("--hot") ? 1 : 2;
    for (const name of args.filter((a) => !a.startsWith("--"))) ctx.enqueue("resolve_company", { name, tier, source: "manual" });
    await runtime.drain();
    break;
  }
  case "poll": {
    // One pass over every due board, then score.
    await jobsAgent.automations![0].run(ctx);
    await runtime.drain();
    console.log(db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all());
    break;
  }
  case "matches": {
    const limit = Number(args[0] ?? 30);
    const rows = db
      .prepare(`SELECT score, title, company_name, location, posted_at, first_seen_at, url, reasons FROM jobs
                WHERE status = 'matched' ORDER BY COALESCE(posted_at, first_seen_at) DESC LIMIT ?`)
      .all(limit) as any[];
    for (const r of rows) {
      console.log(`${String(r.score).padStart(3)}  ${r.title} @ ${r.company_name} — ${r.location || "?"}  (posted ${ago(r.posted_at)} ago)\n     ${r.url}\n     ${JSON.parse(r.reasons).join(" · ")}`);
    }
    console.log(`\n${rows.length} shown`);
    break;
  }
  case "digest": {
    // Pending matches for the daily digest; --send sends them to Telegram and marks them sent.
    const d = await import("./agents/jobs/digest.js");
    if (args.includes("--send")) {
      console.log(`sent ${await d.sendDigest(ctx)} job(s)`);
      break;
    }
    const jobs = d.pendingDigest(ctx);
    for (const j of jobs) console.log(`${String(j.score).padStart(3)}  ${j.title} @ ${j.company_name} — ${j.location || "?"}
     ${j.apply_url || j.url}`);
    console.log(`\n${jobs.length} pending`);
    break;
  }
  case "rescore": {
    // Re-run scoring after editing the profile or scorer: every job not yet submitted, including queued
    // applications. Applications whose job no longer fits are cancelled (never submitted).
    const pending = ['matched', 'rejected', 'ready', 'dry_run', 'needs_user', 'tailoring', 'queued', 'skipped', 'waiting_adapter'];
    const marks = pending.map(() => "?").join(",");
    const ids = db.prepare(`SELECT id FROM jobs WHERE status IN (${marks})`).pluck().all(...pending) as string[];
    db.prepare(`UPDATE jobs SET status = 'new' WHERE status IN (${marks})`).run(...pending);
    for (const id of ids) ctx.enqueue("score_job", { id }, { dedupeKey: `rescore:${id}:${Date.now()}` });
    await runtime.drain();
    const cancelled = db
      .prepare(
        `UPDATE applications SET status = 'skipped', error = 'no longer fits experience rules', updated_at = ?
         WHERE status NOT IN ('submitted', 'submitting', 'skipped') AND job_id IN (SELECT id FROM jobs WHERE status = 'rejected')`,
      )
      .run(Date.now()).changes;
    console.log(`cancelled ${cancelled} queued application(s) that no longer fit`);
    console.log(db.prepare("SELECT status, COUNT(*) n FROM jobs WHERE status != 'baseline' GROUP BY status").all());
    break;
  }
  case "tailor": {
    // Trial run: build one tailored resume for a matched job (by id, or by text in title/company).
    const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
    const q = args.filter((a, i) => a !== "--model" && args[i - 1] !== "--model").join(" ");
    const job = db
      .prepare(`SELECT id, title, company_name FROM jobs WHERE id = ? OR (status = 'matched' AND (title || ' ' || company_name) LIKE ?)
                ORDER BY score DESC LIMIT 1`)
      .get(q, `%${q}%`) as { id: string; title: string; company_name: string } | undefined;
    if (!job) throw new Error(`no matched job for "${q}"`);
    console.log(`Tailoring for ${job.title} @ ${job.company_name} (model: ${model ?? "default"})\n`);
    const { tailorResume } = await import("./agents/jobs/tailor.js");
    const out = await tailorResume(db, job.id, { model, onEvent: (e) => {
      if (e.type !== "assistant") return;
      for (const c of (e as any).message?.content ?? []) {
        if (c.type === "tool_use") console.log(`  · ${c.name} ${String(c.input?.command ?? c.input?.file_path ?? "").slice(0, 100)}`);
        if (c.type === "text" && c.text.trim()) console.log(`  ${c.text.trim().slice(0, 200)}`);
      }
    } });
    console.log(`\nresult: ${out.run.ok ? "ok" : "FAILED " + out.run.error} — ${out.run.result}`);
    console.log(`turns ${out.run.turns}, ${Math.round(out.run.durationMs / 1000)}s, API-equivalent $${out.run.costUsd?.toFixed(2) ?? "?"}`);
    console.log(`checks: pages=${out.checks.pages} overfull=${out.checks.overfull} underfull=${out.checks.underfull}`);
    console.log(`truth check: ${JSON.stringify(out.truth)}\nverdict: ${out.verdict.toUpperCase()}`);
    console.log(`folder: ${out.dir}\npdf: ${out.pdf ?? "(none)"}`);
    break;
  }
  case "plan": {
    // Dry run of the answer engine: read each matched job's form and answer it. Submits nothing.
    const { planApplication, recordPendingQuestions } = await import("./agents/jobs/apply/plan.js");
    const verbose = args.includes("-v");
    const jobs = db
      .prepare(`SELECT id, title, company_name FROM jobs WHERE status = 'matched' AND ats = 'greenhouse' ORDER BY score DESC`)
      .all() as { id: string; title: string; company_name: string }[];
    const pending: { question: string; company: string; title: string }[] = [];
    let ready = 0;
    for (const j of jobs) {
      const plan = await planApplication(db, j.id, "<tailored resume>");
      const counts = plan.fields.reduce<Record<string, number>>((m, p) => {
        const k = p.answer.kind === "value" ? p.answer.source : p.answer.kind;
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {});
      if (!plan.blockers.length) ready++;
      console.log(`${plan.blockers.length ? "⏸ " : "✅"} ${j.title} @ ${j.company_name}  ${JSON.stringify(counts)}`);
      for (const b of plan.blockers) console.log(`     needs you: ${b.slice(0, 140)}`);
      if (verbose)
        for (const p of plan.fields)
          console.log(`     · ${p.field.label.slice(0, 60)} [${p.field.type}${p.field.required ? "*" : ""}] → ${p.answer.kind === "value" ? `${p.answer.note ?? p.answer.value} (${p.answer.source})` : p.answer.kind === "skip" ? `skip: ${p.answer.reason}` : "ASK"}`);
      pending.push(...plan.blockers.map((question) => ({ question, company: j.company_name, title: j.title })));
    }
    const n = recordPendingQuestions(pending, { replace: true });
    console.log(`\n${ready}/${jobs.length} ready to fill with no questions; ${n} distinct questions for you in profile/questions-pending.yaml`);
    break;
  }
  case "fill": {
    // DRY RUN: fill a matched job's application in the bot's Chrome and screenshot it. Never submits.
    const { planApplication } = await import("./agents/jobs/apply/plan.js");
    const { fillGreenhouse } = await import("./agents/jobs/apply/greenhouse-fill.js");
    const { botBrowser, closeBotBrowser } = await import("./agents/jobs/apply/browser.js");
    const { loadProfile } = await import("./agents/jobs/profile.js");
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { DATA_DIR, PROFILE_DIR } = await import("./core/config.js");
    const q = args.filter((a) => !a.startsWith("--")).join(" ");
    const job = db
      .prepare(`SELECT * FROM jobs WHERE id = ? OR (status = 'matched' AND ats = 'greenhouse' AND (title || ' ' || company_name) LIKE ?) ORDER BY score DESC LIMIT 1`)
      .get(q, `%${q}%`) as any;
    if (!job) throw new Error(`no matched Greenhouse job for "${q}"`);
    const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : join(PROFILE_DIR, "Tanish_Resume.pdf");
    const plan = await planApplication(db, job.id, resume);
    if (plan.blockers.length) console.log(`⚠️  ${plan.blockers.length} question(s) still need you; they'll be left empty:\n   ${plan.blockers.join("\n   ")}`);
    const outDir = join(DATA_DIR, "applications", "dry-runs");
    mkdirSync(outDir, { recursive: true });
    const shot = join(outDir, `${job.company_name.replace(/\W+/g, "_")}-${job.external_id}.png`);
    const p = loadProfile();
    const ctxB = await botBrowser();
    const page = await ctxB.newPage();
    const report = await fillGreenhouse(
      page,
      { boardToken: job.board_token, externalId: job.external_id },
      plan,
      { city: p.identity.city, country: p.identity.country, phone: p.identity.phone },
      {
        profile: p,
        bank: (await import("./agents/jobs/apply/answers.js")).loadAnswerBank(),
        job: { company: job.company_name, title: job.title, location: job.location ?? "" },
        resumePdf: resume,
      },
      shot,
    );
    console.log(`\n${job.title} @ ${job.company_name}\n${report.url}`);
    for (const f of report.filled) console.log(`  ✅ ${f.label} → ${f.value}`);
    for (const f of report.failed) console.log(`  ❌ ${f.label}: ${f.error}`);
    for (const f of report.skipped) console.log(`  ·  ${f.label} (${f.reason})`);
    console.log(`captcha: ${report.captcha}\nscreenshot: ${report.screenshot}\nNOT SUBMITTED (dry run)`);
    if (!args.includes("--keep-open")) await closeBotBrowser();
    break;
  }
  case "apply": {
    // Run the full pipeline for one matched job now. --dry-run fills but never submits.
    const { settings, setSetting } = await import("./agents/jobs/pipeline.js");
    const q = args.filter((a) => !a.startsWith("--")).join(" ");
    const job = db
      .prepare(`SELECT id, title, company_name FROM jobs WHERE id = ? OR (status = 'matched' AND (title || ' ' || company_name) LIKE ?) ORDER BY score DESC LIMIT 1`)
      .get(q, `%${q}%`) as { id: string; title: string; company_name: string } | undefined;
    if (!job) throw new Error(`no matched job for "${q}"`);
    const prevDry = settings(ctx).dry_run;
    if (args.includes("--dry-run")) setSetting(ctx, "dry_run", 1);
    console.log(`Applying: ${job.title} @ ${job.company_name}${settings(ctx).dry_run ? " (DRY RUN)" : ""}`);
    ctx.enqueue("prepare_application", { jobId: job.id }, { priority: 50, dedupeKey: `prepare:${job.id}`, maxAttempts: 1 });
    await runtime.drain();
    setSetting(ctx, "dry_run", prevDry);
    const a = db.prepare("SELECT status, resume_verdict, resume_pdf, truth, fill, outcome, error, dir FROM applications WHERE job_id = ?").get(job.id);
    console.log(JSON.stringify(a, null, 2));
    const { closeBotBrowser } = await import("./agents/jobs/apply/browser.js");
    await closeBotBrowser();
    break;
  }
  case "gmail-login": {
    const { gmailLogin } = await import("./core/google/auth.js");
    const r = await gmailLogin();
    console.log(`✅ Gmail connected: ${r.email} (scope: ${r.scope})`);
    break;
  }
  case "gmail-check": {
    const { gmailProfile } = await import("./core/google/auth.js");
    const p = await gmailProfile();
    console.log(`✅ Gmail read-only works: ${p.emailAddress}, ${p.messagesTotal} messages`);
    break;
  }
  case "variants": {
    // variants build [names…] [--model opus] | variants list | variants approve <name…>
    const v = await import("./agents/jobs/variants.js");
    const [sub, ...rest] = args;
    if (sub === "build") {
      const { buildVariant } = await import("./agents/jobs/tailor.js");
      // A stray network error in one task must not stop the whole bot (launchd would restart it mid-application).
    process.on("unhandledRejection", (e) => console.error("unhandled:", String(e).split("\n")[0]));
    // Applications interrupted by a crash: still filling → retry; Submit possibly clicked → owner checks first.
    {
      const now = Date.now();
      const retry = db.prepare("SELECT job_id FROM applications WHERE status = 'applying'").pluck().all() as string[];
      for (const jobId of retry) {
        db.prepare("UPDATE applications SET status = 'ready', updated_at = ? WHERE job_id = ?").run(now, jobId);
        ctx.enqueue("submit_application", { jobId }, { priority: 20, dedupeKey: `submit:${jobId}:${now}`, maxAttempts: 1 });
      }
      const unsure = db.prepare("UPDATE applications SET status = 'needs_user', error = 'interrupted right at Submit: check your email before re-applying', updated_at = ? WHERE status = 'submitting'").run(now).changes;
      if (retry.length || unsure) console.log(`resumed ${retry.length} interrupted application(s); ${unsure} need a check`);
    }
    const tg = await import("./core/channels/telegram.js");
      const model = rest.includes("--model") ? rest[rest.indexOf("--model") + 1] : "sonnet";
      const names = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--model");
      for (const name of names.length ? names : Object.keys(v.VARIANT_BRIEFS)) {
        console.log(`building ${name} (${model})…`);
        let out = await buildVariant(name, v.VARIANT_BRIEFS[name], { model });
        if (out.verdict === "review") out = await buildVariant(name, v.VARIANT_BRIEFS[name], { model, bannedTerms: out.truth?.borrowedTerms });
        const tex = out.pdf?.replace(/\.pdf$/, ".tex") ?? "";
        v.saveVariant({ name, pdf: out.pdf ?? "", tex, verdict: out.verdict, approved: false, builtAt: Date.now() });
        console.log(`  ${name}: ${out.verdict.toUpperCase()} · ${out.run.turns} turns · ${Math.round(out.run.durationMs / 1000)}s · $${out.run.costUsd?.toFixed(2)} eq · truth ${JSON.stringify(out.truth)}`);
        if (out.pdf) await tg.notifyOwnerFile(out.pdf, `📄 Resume variant "${name}" (${out.verdict}). Review it once; approve on the Mac with: npm run bot -- variants approve ${name}`).catch(() => undefined);
      }
    } else if (sub === "approve") {
      for (const name of rest) console.log(`approved ${v.approveVariant(name).name}`);
    } else {
      for (const r of v.loadVariants()) console.log(`${r.approved ? "✅" : "⏳"} ${r.name.padEnd(10)} ${r.verdict.padEnd(7)} ${r.pdf}`);
    }
    break;
  }
  case "applied": {
    // applied [--sync]: the never-apply-twice ledger (bot submissions + Gmail confirmations)
    if (args.includes("--sync")) await jobsAgent.automations!.find((a) => a.id === "sync-applied")!.run(ctx);
    const rows = db.prepare("SELECT source, company, title, date(applied_at/1000,'unixepoch') d FROM applied ORDER BY applied_at DESC LIMIT 60").all() as any[];
    for (const r of rows) console.log(`${r.d}  ${r.source.padEnd(5)}  ${r.company}${r.title ? ` — ${r.title}` : ""}`);
    console.log(`${db.prepare("SELECT COUNT(*) FROM applied").pluck().get()} in ledger`);
    break;
  }
  case "pair": {
    // A stray network error in one task must not stop the whole bot (launchd would restart it mid-application).
    process.on("unhandledRejection", (e) => console.error("unhandled:", String(e).split("\n")[0]));
    // Applications interrupted by a crash: still filling → retry; Submit possibly clicked → owner checks first.
    {
      const now = Date.now();
      const retry = db.prepare("SELECT job_id FROM applications WHERE status = 'applying'").pluck().all() as string[];
      for (const jobId of retry) {
        db.prepare("UPDATE applications SET status = 'ready', updated_at = ? WHERE job_id = ?").run(now, jobId);
        ctx.enqueue("submit_application", { jobId }, { priority: 20, dedupeKey: `submit:${jobId}:${now}`, maxAttempts: 1 });
      }
      const unsure = db.prepare("UPDATE applications SET status = 'needs_user', error = 'interrupted right at Submit: check your email before re-applying', updated_at = ? WHERE status = 'submitting'").run(now).changes;
      if (retry.length || unsure) console.log(`resumed ${retry.length} interrupted application(s); ${unsure} need a check`);
    }
    const tg = await import("./core/channels/telegram.js");
    if (tg.ownerChatId()) {
      console.log("Telegram already paired.");
      break;
    }
    const code = tg.beginPairing();
    console.log(`Send this to your bot on Telegram within 10 minutes:  /start ${code}`);
    const ac = new AbortController();
    const timer = setInterval(() => {
      if (tg.ownerChatId()) {
        console.log("PAIRED");
        ac.abort();
      }
    }, 1000);
    setTimeout(() => ac.abort(), 10 * 60_000);
    await tg.pollTelegram({ commands: {}, signal: ac.signal });
    clearInterval(timer);
    if (!tg.ownerChatId()) console.log("pairing timed out");
    break;
  }
  case "rejections": {
    const rows = db
      .prepare(`SELECT json_extract(reasons, '$[0]') reason, COUNT(*) n FROM jobs WHERE status = 'rejected' GROUP BY 1 ORDER BY n DESC LIMIT 25`)
      .all();
    console.table(rows);
    break;
  }
  case "run": {
    // One bot at a time: a second copy would double-process the queue.
    const { existsSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const { DATA_DIR } = await import("./core/config.js");
    const pidFile = `${DATA_DIR}/bot.pid`;
    const other = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    const alive = (pid: number) => {
      try {
        return pid > 0 && pid !== process.pid && (process.kill(pid, 0), true);
      } catch {
        return false;
      }
    };
    if (alive(other)) {
      console.log(`grokBot is already running (pid ${other}). Stop it first: npm run bot -- stop`);
      process.exit(0);
    }
    writeFileSync(pidFile, String(process.pid));
    // Keep the Mac awake for as long as this process lives, however it was started (-i idle, -m disk, -s system on AC).
    spawn("/usr/bin/caffeinate", ["-ims", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
    // A stray network error in one task must not stop the whole bot (launchd would restart it mid-application).
    process.on("unhandledRejection", (e) => console.error("unhandled:", String(e).split("\n")[0]));
    // Applications interrupted by a crash: still filling → retry; Submit possibly clicked → owner checks first.
    {
      const now = Date.now();
      const retry = db.prepare("SELECT job_id FROM applications WHERE status = 'applying'").pluck().all() as string[];
      for (const jobId of retry) {
        db.prepare("UPDATE applications SET status = 'ready', updated_at = ? WHERE job_id = ?").run(now, jobId);
        ctx.enqueue("submit_application", { jobId }, { priority: 20, dedupeKey: `submit:${jobId}:${now}`, maxAttempts: 1 });
      }
      const unsure = db.prepare("UPDATE applications SET status = 'needs_user', error = 'interrupted right at Submit: check your email before re-applying', updated_at = ? WHERE status = 'submitting'").run(now).changes;
      if (retry.length || unsure) console.log(`resumed ${retry.length} interrupted application(s); ${unsure} need a check`);
    }
    const tg = await import("./core/channels/telegram.js");
    const { settings, setSetting } = await import("./agents/jobs/pipeline.js");
    if (args.includes("--dry-run")) setSetting(ctx, "dry_run", 1);
    console.log(`grokBot running${settings(ctx).dry_run ? " (DRY RUN: fills but never submits)" : ""}. Ctrl+C to stop.`);
    runtime.start();
    const count = (sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;
    void tg.pollTelegram({
      commands: {
        status: async (_a, reply) => {
          const s = settings(ctx);
          const dayStart = new Date().setHours(0, 0, 0, 0);
          const by = db.prepare("SELECT status, COUNT(*) n FROM applications GROUP BY status").all() as { status: string; n: number }[];
          await reply(
            [
              `${s.paused ? "⏸ PAUSED" : s.find_only ? `🔎 FIND ONLY (digest at ${s.digest_hour}:00)` : s.dry_run ? "🧪 DRY RUN" : "▶️ Running"}`,
              `Applied today: ${count("SELECT COUNT(*) FROM applications WHERE status='submitted' AND submitted_at >= ?", dayStart)} / ${s.daily_cap}`,
              `Applied total: ${count("SELECT COUNT(*) FROM applications WHERE status='submitted'")}`,
              `Matches waiting: ${count("SELECT COUNT(*) FROM jobs WHERE status='matched'")}`,
              ...by.map((b) => `• ${b.status}: ${b.n}`),
            ].join("\n"),
          );
        },
        queue: async (_a, reply) => {
          const rows = db
            .prepare(`SELECT j.title, j.company_name, a.error FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.status = 'needs_user' ORDER BY a.updated_at DESC LIMIT 10`)
            .all() as any[];
          await reply(rows.length ? rows.map((r) => `• ${r.title} @ ${r.company_name}\n  ${String(r.error).slice(0, 160)}`).join("\n") : "Nothing needs you 🎉");
        },
        pause: async (_a, reply) => (setSetting(ctx, "paused", 1), reply("⏸ Paused. Nothing will be submitted until /resume.")),
        resume: async (_a, reply) => (setSetting(ctx, "paused", 0), reply("▶️ Resumed.")),
        dryrun: async (a, reply) => (setSetting(ctx, "dry_run", a === "off" ? 0 : 1), reply(a === "off" ? "Live: applications will be submitted." : "🧪 Dry run: fills and screenshots, never submits.")),
        jobs: async () => void (await (await import("./agents/jobs/digest.js")).sendDigest(ctx)),
        mode: async (a, reply) => {
          if (a === "find" || a === "apply") setSetting(ctx, "find_only", a === "find" ? 1 : 0);
          const n = Number(a);
          if (a && Number.isInteger(n) && n >= 0 && n <= 23) setSetting(ctx, "digest_hour", n);
          const s = settings(ctx);
          await reply(s.find_only ? `🔎 Find only: matches come in one list at ${s.digest_hour}:00 (or /jobs any time). No Claude usage, nothing is applied.` : "▶️ Apply mode: the bot prepares and submits applications itself.");
        },
        cap: async (a, reply) => {
          const n = Number(a);
          if (n > 0) setSetting(ctx, "daily_cap", n);
          await reply(`Daily cap: ${settings(ctx).daily_cap}`);
        },
      },
    });
    const stop = async () => {
      runtime.stop();
      rmSync(pidFile, { force: true });
      // Close Chrome cleanly so it doesn't leave its profile lock behind.
      await (await import("./agents/jobs/apply/browser.js")).closeBotBrowser().catch(() => undefined);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "browser-login": {
    // Sign in (Google, Workday, LinkedIn…) inside the bot's own Chrome profile using plain Chrome, not automation.
    // The bot pauses, waits for its browser to let go of the profile, and resumes when you quit Chrome.
    const { readlinkSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const { BROWSER_PROFILE } = await import("./agents/jobs/apply/browser.js");
    const { settings, setSetting } = await import("./agents/jobs/pipeline.js");
    const wasPaused = settings(ctx).paused;
    setSetting(ctx, "paused", 1);
    // Chrome's lock is a symlink to "<host>-<pid>"; a crashed or killed Chrome leaves it behind, so check the pid.
    const locked = () => {
      try {
        const pid = Number(readlinkSync(`${BROWSER_PROFILE}/SingletonLock`).split("-").pop());
        return process.kill(pid, 0), true;
      } catch {
        return false;
      }
    };
    const busy = () => db.prepare("SELECT COUNT(*) FROM applications WHERE status = 'submitting'").pluck().get() as number;
    for (let i = 0; (locked() || busy()) && i < 60; i++) {
      if (i === 0) console.log("Paused the bot; waiting for its browser to close (up to 5 minutes)…");
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (locked()) {
      if (!wasPaused) setSetting(ctx, "paused", 0);
      throw new Error("The bot's browser is still open. Try again in a few minutes.");
    }
    const urls = args.length ? args : ["https://accounts.google.com/", "https://mail.google.com/"];
    console.log("Opening Chrome with the bot's profile. Sign in to Google (and any job sites), then quit Chrome (⌘Q).");
    const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [`--user-data-dir=${BROWSER_PROFILE}`, "--no-first-run", "--no-default-browser-check", ...urls], { stdio: "ignore" });
    await new Promise((r) => chrome.on("exit", r));
    if (!wasPaused) setSetting(ctx, "paused", 0);
    console.log(wasPaused ? "Done. The bot stays paused (it was paused before)." : "Done. The bot has resumed and will use these logins.");
    break;
  }
  case "start":
  case "stop":
  case "restart":
  case "status": {
    // Background bot under launchd, only while started; never at login.
    const svc = await import("./core/service.js");
    console.log(cmd === "start" ? svc.startService() : cmd === "stop" ? svc.stopService() : cmd === "restart" ? svc.restartService() : svc.serviceStatus());
    break;
  }
  default:
    console.log(`usage: npm run bot -- <command>
  seed                         resolve the starter company list into the directory
  add-company <names> [--hot]  add companies (hot = poll every 3 min)
  poll                         poll all due boards once and score new postings
  matches [n]                  show newest matched jobs
  rejections                   why postings were skipped
  run                          run continuously (polling + scoring)
  browser-login [urls…]        sign in to Google / job sites inside the bot's Chrome profile (plain Chrome)
  start | stop | restart | status   run the bot in the background (restarts after crashes, never at login)`);
}
