import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { DATA_DIR, PROFILE_DIR, ROOT } from "../../core/config.js";
import type { DB } from "../../core/db.js";
import { runClaudeCode, type ClaudeCodeEvent, type ClaudeCodeResult } from "../../core/workers/claude-code.js";
import { loadProfile } from "./profile.js";

const LATEX_BIN = join(ROOT, "tools", "latex", "bin");
const BASE_TEX = join(PROFILE_DIR, "resume.tex");

/** Shell commands the resume session may run. LaTeX tools execute inside the sandboxed container. */
const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Skill",
  "Bash(pdflatex:*)",
  "Bash(pdfinfo:*)",
  "Bash(pdftoppm:*)",
  "Bash(grep:*)",
  "Bash(sed:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(ls:*)",
];

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

/** The owner's resume-tailoring skill, synced from claude.ai into ~/.claude/skills/synced/<id>/resume-tailoring. */
function findResumeSkill(): string {
  const synced = join(homedir(), ".claude", "skills", "synced");
  for (const d of existsSync(synced) ? readdirSync(synced) : []) {
    const p = join(synced, d, "resume-tailoring");
    if (existsSync(join(p, "SKILL.md"))) return p;
  }
  const local = join(homedir(), ".claude", "skills", "resume-tailoring");
  if (existsSync(join(local, "SKILL.md"))) return local;
  throw new Error("resume-tailoring skill not found");
}

function factsMarkdown(): string {
  const p = loadProfile();
  return [
    "# Facts about the owner (true; the only source besides base_resume.tex)",
    "",
    "```yaml",
    YAML.stringify({ identity: p.identity, facts: p.facts }).trim(),
    "```",
  ].join("\n");
}

function instructions(job: { company: string; title: string }, fileStem: string): string {
  return `# Resume build: ${job.title} at ${job.company}

You are running **headless inside grokBot**. Nobody can answer questions during this run.

## Inputs (in this folder)
- \`jd.md\`: the job description.
- \`base_resume.tex\`: the owner's real resume. It is also the **template**.
- \`facts.md\`: true facts about the owner.
- \`.claude/skills/resume-tailoring/\`: the method to follow (read SKILL.md and references/power-verbs.md first).

## Overrides to the skill (these win over SKILL.md)
1. **Template = base_resume.tex.** Keep its preamble, packages, fonts, macros, margins, header and section styling exactly.
   There is no \`assets/template.tex\`; don't create a new layout. Single column, ATS-safe.
2. **The owner is Tanish Saini.** Ignore any other person, file name or project named in the skill
   (e.g. "Yash Gupta", "AI Interviewer", "Fluxpay", "Google referral").
   Write \`${fileStem}.tex\` and compile it to \`${fileStem}.pdf\`.
3. **Truth source:** only base_resume.tex and facts.md. You may select, reorder, rephrase and re-bold.
   Never add an employer, title, date, tool, project, certification or number that isn't there. Keep every metric exactly as given.
4. **Total experience is ${loadProfile().facts.total_experience_years} years.** Never claim more (no "2+ years", no "senior").
5. **"Ask, don't presume" → write it down instead.** Put each question under "Questions for owner" in notes.md and keep the safe choice (leave it out) in the resume.
6. **Tools:** \`pdflatex\`, \`pdfinfo\`, \`pdftoppm\` work here (they run in a sandbox; the first call may take a few seconds).
   Compile: \`pdflatex -interaction=nonstopmode ${fileStem}.tex\` · Pages: \`pdfinfo ${fileStem}.pdf\` ·
   Render: \`pdftoppm -png -r 150 ${fileStem}.pdf page\`, then **Read the PNG** to inspect it visually. Iterate as the skill says.
7. No web access. Don't touch files outside this folder.

## Finish
Write \`notes.md\` with: role thesis; JD keyword coverage (covered / missing, with %); gaps flagged honestly;
the verification checklist with pass/fail per item; the verb-count audit output; questions for owner.
Your final message is one line: \`DONE ${fileStem}.pdf\` or \`FAILED <reason>\`.
`;
}

export interface TailorOutcome {
  dir: string;
  pdf: string | null;
  run: ClaudeCodeResult;
  checks: { pages: number | null; overfull: number; underfull: number };
}

export async function tailorResume(db: DB, jobId: string, onEvent?: (e: ClaudeCodeEvent) => void): Promise<TailorOutcome> {
  if (!existsSync(BASE_TEX)) throw new Error(`Base resume missing: put your LaTeX source at ${BASE_TEX}`);
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!job) throw new Error(`No job ${jobId}`);

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dir = join(DATA_DIR, "applications", `${date}-${slug(job.company_name)}-${slug(job.title)}`);
  const fileStem = `Tanish_Saini_${slug(job.company_name)}_${slug(job.title).slice(0, 30)}_Resume`;
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, "jd.md"),
    `# ${job.title}\n\n- Company: ${job.company_name}\n- Location: ${job.location}\n- URL: ${job.url}\n\n## Description\n\n${job.description ?? ""}\n`,
  );
  cpSync(BASE_TEX, join(dir, "base_resume.tex"));
  writeFileSync(join(dir, "facts.md"), factsMarkdown());
  writeFileSync(join(dir, "CLAUDE.md"), instructions({ company: job.company_name, title: job.title }, fileStem));
  cpSync(findResumeSkill(), join(dir, ".claude", "skills", "resume-tailoring"), { recursive: true });

  const run = await runClaudeCode({
    cwd: dir,
    prompt: `Build the tailored one-page resume described in CLAUDE.md for this job (jd.md). Follow CLAUDE.md exactly.`,
    allowedTools: ALLOWED_TOOLS,
    extraPath: [LATEX_BIN],
    maxTurns: 80,
    timeoutMs: 30 * 60_000,
    onEvent,
  });

  // Independent verification: don't take the session's word for it.
  const pdf = join(dir, `${fileStem}.pdf`);
  const checks = { pages: null as number | null, overfull: 0, underfull: 0 };
  if (existsSync(pdf)) {
    const info = execFileSync(join(LATEX_BIN, "pdfinfo"), [`${fileStem}.pdf`], { cwd: dir }).toString();
    checks.pages = Number(info.match(/Pages:\s+(\d+)/)?.[1] ?? NaN);
    const log = existsSync(join(dir, `${fileStem}.log`)) ? readFileSync(join(dir, `${fileStem}.log`), "utf8") : "";
    checks.overfull = (log.match(/Overfull/g) ?? []).length;
    checks.underfull = (log.match(/Underfull/g) ?? []).length;
  }
  return { dir, pdf: existsSync(pdf) ? pdf : null, run, checks };
}
