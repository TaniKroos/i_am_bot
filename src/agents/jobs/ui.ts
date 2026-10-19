import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentContext } from "../../core/agent.js";
import { alreadyApplied, recordApplied } from "./applied.js";
import { OPEN, type DigestJob } from "./digest.js";
import { draftNote, peopleFor, regionOf, searchLinks } from "./referrals.js";

/**
 * Local web page for the last WINDOW_DAYS of matches: apply links, referral people, the note to paste,
 * and buttons to mark a job applied or a person messaged. Listens on 127.0.0.1 only.
 * Older jobs just drop off the page; the database keeps them so they are never reported as new again.
 */

const WINDOW_DAYS = 7;

function listJobs(ctx: AgentContext) {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const rows = ctx.db
    .prepare(
      `SELECT j.id, j.rowid ref, j.score, j.title, j.company_name, j.location, j.url, j.apply_url, j.external_id, j.posted_at,
              COALESCE(j.digested_at, j.first_seen_at) seen_at, a.source applied_source, a.applied_at
       FROM jobs j LEFT JOIN applied a ON a.job_id = j.id
       WHERE j.status IN (${OPEN.map(() => "?").join(", ")}, 'submitted') AND COALESCE(j.digested_at, j.first_seen_at) >= ?
       GROUP BY j.id ORDER BY seen_at DESC, j.score DESC`,
    )
    .all(...OPEN, since) as any[];
  const sent = ctx.db.prepare("SELECT person_id FROM outreach WHERE job_id = ?").pluck();
  return rows.map((r) => {
    const job = r as DigestJob;
    const people = peopleFor(ctx, r.company_name);
    const mine = new Set(sent.all(r.id) as number[]);
    return {
      id: r.id,
      score: r.score,
      title: r.title,
      company: r.company_name,
      location: r.location,
      url: r.apply_url || r.url,
      postedAt: r.posted_at,
      seenAt: r.seen_at,
      // Marked here, by the bot, or found in Gmail (including reposts and requisition matches).
      applied: r.applied_source ? { source: r.applied_source, at: r.applied_at } : alreadyApplied(ctx.db, r) ? { source: "seen in Gmail", at: null } : null,
      people: people.map((p) => ({ id: p.id, name: p.name, headline: p.headline, url: p.url, alumni: p.alumni, sent: mine.has(p.id), contactedAt: p.contactedAt })),
      note: draftNote(job, people[0]?.name.split(/\s+/)[0] ?? "there"),
      searches: searchLinks(r.company_name, regionOf(r.location)).map((b) => ({ text: b.text, url: b.url })),
    };
  });
}

async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  return JSON.parse(s || "{}");
}

export function startUi(ctx: AgentContext, port: number): Promise<string> {
  const server = createServer(async (req, res: ServerResponse) => {
    const json = (data: unknown, code = 200) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(data)));
    try {
      if (req.method === "GET" && req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }), res.end(PAGE);
      if (req.method === "GET" && req.url === "/api/jobs") return json(listJobs(ctx));
      if (req.url === "/favicon.ico") return res.writeHead(204), res.end();
      // Only this page may post (blocks other sites in the browser from calling the local API).
      if (req.method === "POST" && req.headers["content-type"] !== "application/json") return json({ error: "bad request" }, 400);
      if (req.method === "POST" && req.url === "/api/applied") {
        const { jobId, on } = await body(req);
        const job = ctx.db.prepare("SELECT company_name, title FROM jobs WHERE id = ?").get(jobId) as any;
        if (!job) return json({ error: "no such job" }, 404);
        if (on) recordApplied(ctx.db, { jobId, company: job.company_name, title: job.title, source: "manual", appliedAt: Date.now(), ref: `manual:${jobId}` });
        else ctx.db.prepare("DELETE FROM applied WHERE ref = ?").run(`manual:${jobId}`);
        return json({ ok: true });
      }
      if (req.method === "POST" && req.url === "/api/sent") {
        const { personId, jobId, on } = await body(req);
        if (on) ctx.db.prepare("INSERT INTO outreach (person_id, job_id, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(personId, jobId, Date.now());
        else ctx.db.prepare("DELETE FROM outreach WHERE person_id = ? AND job_id = ?").run(personId, jobId);
        return json({ ok: true });
      }
      json({ error: "not found" }, 404);
    } catch (e) {
      json({ error: String(e) }, 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://localhost:${port}`));
  });
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grokBot jobs</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5e2; --accent:#2f6fde; --ok:#1f8a4c; --chip:#f0f0ec; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151516; --card:#1f1f21; --fg:#ececee; --muted:#9a9aa0; --line:#2e2e31; --accent:#6c9cff; --ok:#4cc27e; --chip:#2a2a2d; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; z-index:1; }
  h1 { font-size:16px; margin:0 8px 0 0; }
  .tabs button { border:1px solid var(--line); background:var(--card); color:var(--fg); padding:5px 12px; border-radius:999px; cursor:pointer; font:inherit; }
  .tabs button.on { background:var(--fg); color:var(--bg); border-color:var(--fg); }
  input[type=search] { flex:1; min-width:160px; padding:6px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; }
  main { max-width:860px; margin:0 auto; padding:16px; display:grid; gap:10px; }
  .job { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .job.done { opacity:.6; }
  .top { display:flex; gap:10px; align-items:flex-start; }
  .score { font-weight:600; font-variant-numeric:tabular-nums; min-width:34px; text-align:center; padding:2px 6px; border-radius:6px; background:var(--chip); }
  .main { flex:1; min-width:0; }
  .title { font-weight:600; color:var(--fg); text-decoration:none; }
  .title:hover { text-decoration:underline; }
  .meta { color:var(--muted); font-size:13px; }
  .actions { display:flex; gap:6px; flex-shrink:0; }
  .btn { border:1px solid var(--line); background:var(--card); color:var(--fg); padding:5px 10px; border-radius:7px; cursor:pointer; font:inherit; font-size:13px; text-decoration:none; white-space:nowrap; }
  .btn:hover { border-color:var(--muted); }
  .btn.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .btn.ok { color:var(--ok); border-color:var(--ok); }
  details { margin-top:8px; }
  summary { cursor:pointer; color:var(--muted); font-size:13px; }
  .people { margin:8px 0 0; padding:0; list-style:none; display:grid; gap:6px; }
  .people li { display:flex; gap:8px; align-items:center; }
  .people .who { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .people a { color:var(--accent); text-decoration:none; }
  .note { margin-top:10px; background:var(--chip); border-radius:8px; padding:8px 10px; display:flex; gap:8px; align-items:flex-start; }
  .note p { margin:0; flex:1; }
  .links { margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
  @media (max-width:560px) { .top { flex-wrap:wrap; } .actions { width:100%; } }
</style>
</head>
<body>
<header>
  <h1>Jobs · last ${WINDOW_DAYS} days</h1>
  <div class="tabs"><button data-tab="todo" class="on">To apply</button> <button data-tab="applied">Applied</button></div>
  <input type="search" id="q" placeholder="Filter by title, company, city">
</header>
<main id="list"><p class="empty">Loading…</p></main>
<script>
let jobs = [], tab = "todo", q = "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const ago = (t) => { if (!t) return ""; const h = Math.round((Date.now() - t) / 3.6e6); return h < 24 ? h + "h ago" : Math.round(h / 24) + "d ago"; };
const post = (url, data) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

async function load() { jobs = await (await fetch("/api/jobs")).json(); render(); }

function render() {
  const shown = jobs.filter((j) => (tab === "applied") === !!j.applied && (!q || (j.title + " " + j.company + " " + (j.location || "")).toLowerCase().includes(q)));
  document.querySelectorAll(".tabs button").forEach((b) => {
    const n = jobs.filter((j) => (b.dataset.tab === "applied") === !!j.applied).length;
    b.textContent = (b.dataset.tab === "applied" ? "Applied" : "To apply") + " (" + n + ")";
    b.classList.toggle("on", b.dataset.tab === tab);
  });
  document.getElementById("list").innerHTML = shown.length ? shown.map(card).join("") : '<p class="empty">Nothing here.</p>';
}

function card(j) {
  const sentCount = j.people.filter((p) => p.sent).length;
  const people = j.people.map((p) => '<li><span class="who"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>' + (p.alumni ? " 🎓" : "") +
    ' <span class="meta">' + esc(p.headline) + '</span></span><button class="btn' + (p.sent ? " ok" : "") + '" data-sent="' + p.id + '" data-job="' + esc(j.id) + '">' + (p.sent ? "✓ Sent" : "Mark sent") + '</button></li>').join("");
  return '<div class="job' + (j.applied ? " done" : "") + '">' +
    '<div class="top"><span class="score">' + (j.score ?? "") + '</span><div class="main">' +
    '<a class="title" href="' + esc(j.url) + '" target="_blank" rel="noopener">' + esc(j.title) + '</a>' +
    '<div class="meta">' + esc(j.company) + (j.location ? " · " + esc(j.location) : "") + (j.postedAt ? " · posted " + ago(j.postedAt) : "") +
    (j.applied ? " · applied" + (j.applied.at ? " " + ago(j.applied.at) : "") + (j.applied.source !== "manual" ? " (" + esc(j.applied.source) + ")" : "") : "") + '</div></div>' +
    '<div class="actions"><a class="btn primary" href="' + esc(j.url) + '" target="_blank" rel="noopener">Apply</a>' +
    (!j.applied || j.applied.source === "manual" ? '<button class="btn' + (j.applied ? " ok" : "") + '" data-applied="' + esc(j.id) + '">' + (j.applied ? "✓ Applied" : "Mark applied") + '</button>' : "") + '</div></div>' +
    '<details><summary>Referrals' + (j.people.length ? " · " + j.people.length + " people" : "") + (sentCount ? " · " + sentCount + " messaged" : "") + '</summary>' +
    (people ? '<ul class="people">' + people + '</ul>' : '<p class="meta">No people found yet: use the LinkedIn searches below.</p>') +
    '<div class="note"><p>' + esc(j.note) + '</p><button class="btn" data-copy="' + esc(j.note) + '">Copy</button></div>' +
    '<div class="links">' + j.searches.map((s) => '<a class="btn" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.text) + '</a>').join("") + '</div>' +
    '</details></div>';
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; render(); }
  else if (t.dataset.copy) { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = "Copied"; setTimeout(() => (t.textContent = "Copy"), 1200); }
  else if (t.dataset.applied) { const j = jobs.find((x) => x.id === t.dataset.applied); await post("/api/applied", { jobId: j.id, on: !j.applied }); await load(); }
  else if (t.dataset.sent) { const open = [...document.querySelectorAll("details")].map((d) => d.open); const on = !t.classList.contains("ok");
    await post("/api/sent", { personId: Number(t.dataset.sent), jobId: t.dataset.job, on }); await load();
    document.querySelectorAll("details").forEach((d, i) => (d.open = open[i] ?? false)); }
});
document.getElementById("q").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); render(); });
load();
</script>
</body>
</html>`;
