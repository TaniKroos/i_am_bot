import { getDb } from "./core/db.js";
import { Runtime } from "./core/runtime.js";
import { jobsAgent } from "./agents/jobs/index.js";
import { SEED_TIER1, SEED_TIER2 } from "./agents/jobs/seed.js";

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
    for (const name of SEED_TIER1) ctx.enqueue("resolve_company", { name, tier: 1, source: "seed" }, { dedupeKey: `resolve:${name}` });
    for (const name of SEED_TIER2) ctx.enqueue("resolve_company", { name, tier: 2, source: "seed" }, { dedupeKey: `resolve:${name}` });
    await runtime.drain();
    const n = db.prepare("SELECT ats, COUNT(*) n FROM companies GROUP BY ats").all();
    const u = db.prepare("SELECT COUNT(*) FROM unresolved_companies").pluck().get();
    console.log("companies by ATS:", n, "| unresolved (likely Workday/custom):", u);
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
