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
  case "rescore": {
    // Re-run scoring after editing the profile or scorer (only jobs not yet acted on).
    const ids = db.prepare("SELECT id FROM jobs WHERE status IN ('matched', 'rejected')").pluck().all() as string[];
    db.prepare("UPDATE jobs SET status = 'new' WHERE status IN ('matched', 'rejected')").run();
    for (const id of ids) ctx.enqueue("score_job", { id });
    await runtime.drain();
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
      { city: p.identity.city, country: p.identity.country, phone: p.identity.phone.replace(/[^\d+]/g, "") },
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
  case "pair": {
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
    console.log("grokBot running. Ctrl+C to stop.");
    runtime.start();
    process.on("SIGINT", () => (runtime.stop(), process.exit(0)));
    break;
  }
  default:
    console.log(`usage: npm run bot -- <command>
  seed                         resolve the starter company list into the directory
  add-company <names> [--hot]  add companies (hot = poll every 3 min)
  poll                         poll all due boards once and score new postings
  matches [n]                  show newest matched jobs
  rejections                   why postings were skipped
  run                          run continuously (polling + scoring)`);
}
