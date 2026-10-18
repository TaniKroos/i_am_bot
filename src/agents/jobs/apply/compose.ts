import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { DATA_DIR, PROFILE_DIR } from "../../../core/config.js";
import { runClaudeCode } from "../../../core/workers/claude-code.js";
import { loadProfile } from "../profile.js";
import { norm, numbers, techTokens, texToText } from "../truthcheck.js";
import { matchOption } from "./answers.js";
import type { FormField } from "./types.js";

/**
 * Answers to questions the rules can't answer ("Describe a distributed system you built…", "Have you used Kafka?"),
 * written by Claude from the owner's own material only: profile/experience.md, resume.tex and profile.yaml.
 * Every answer is checked like a tailored resume: numbers must exist in the sources, and a technology the owner
 * never claimed may only appear in a sentence that says they haven't used it.
 */

export interface Composed {
  /** Form field key → answer text, or the option value for dropdowns. */
  values: Record<string, string | string[]>;
  /** Shown to the owner afterwards. */
  log: { question: string; answer: string }[];
  /** Questions that stay with the owner, with the reason. */
  rejected: { question: string; reason: string }[];
}

const NEGATION = /\b(not|never|haven.?t|hasn.?t|don.?t|no (professional |production |hands-on )?experience|yet to|limited|instead of|rather than)\b/i;

function sources(): { text: string; forbidden: string[] } {
  const profile = loadProfile();
  const exp = existsSync(join(PROFILE_DIR, "experience.md")) ? readFileSync(join(PROFILE_DIR, "experience.md"), "utf8") : "";
  const resume = texToText(readFileSync(join(PROFILE_DIR, "resume.tex"), "utf8"));
  const facts = YAML.stringify({ facts: profile.facts, resume: profile.resume, skills: profile.targeting.skills });
  return { text: `${exp}\n\n# Resume\n${resume}\n\n# Profile\n${facts}`, forbidden: profile.facts.do_not_list_terms ?? [] };
}

/** Problems with one answer, or [] when it only says things the sources support. */
function check(answer: string, question: string, jd: string, src: string, forbidden: string[]): string[] {
  const problems: string[] = [];
  const known = numbers(src);
  const unknown = [...numbers(answer)].filter((n) => !known.has(n));
  if (unknown.length) problems.push(`numbers not in your sources: ${unknown.join(", ")}`);
  const srcTerms = new Set([...techTokens(src), ...[...src.toLowerCase().matchAll(/[a-z0-9.#+/-]+/g)].map((m) => norm(m[0]))]);
  const asked = techTokens(`${question}\n${jd}`);
  for (const sentence of answer.split(/(?<=[.!?;])\s+/)) {
    if (NEGATION.test(sentence)) continue;
    const borrowed = [...techTokens(sentence)].filter((t) => asked.has(t) && !srcTerms.has(t));
    if (borrowed.length) problems.push(`claims ${borrowed.join(", ")}, which isn't in your experience`);
  }
  const lower = answer.toLowerCase();
  for (const t of forbidden) if (new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(lower)) problems.push(`uses "${t}"`);
  return problems;
}

const RULES = `You answer job application questions for Tanish Saini, in his voice (first person), using ONLY the material in this prompt.

Rules:
- Never invent anything: no project, technology, number, employer, metric or responsibility that the material doesn't state.
  Copy numbers exactly as written (e.g. "800+", "50,000+", "sub-50ms").
- No frequency, depth or skill-level claims the material doesn't make ("daily", "extensively", "expert", "deep experience").
- Keep each fact with the project it belongs to. Don't volunteer things he hasn't done unless the question asks about them.
- If he hasn't done something, say so honestly and briefly, then mention the closest real experience
  (e.g. "I haven't used Kafka in production; for messaging I've used Redis pub/sub in Steve…").
- Yes/no questions: "Yes" only when the material clearly and directly supports it. "No" when the material says he hasn't
  done it. When it is unclear or a judgement call, answer null so Tanish decides once.
- "In production" / "professional" / "commercial" means his Xceedance work only. Steve and JobSeeker are personal projects
  with no users: never present them as production systems, and say "personal project" when you use them as examples.
- Dropdowns: the answer must be exactly one of the listed option labels.
- Write clean, grammatical sentences; don't paste fragments of the material.
- Short text fields: one line. Long text fields: 60–150 words, plain and specific, no buzzwords, no greetings or sign-offs.
- If the question needs a personal fact the material doesn't contain (an ID number, a date, a person's name, a preference
  he hasn't stated), set "answer" to null.

Reply with ONLY a JSON array, one object per question, in the same order:
[{"key": "<key>", "answer": "<text or option label>" | null}]`;

/** Compose answers for `fields` (unanswered by the rules). Cached per application folder. */
export async function composeAnswers(job: { id: string; company_name: string; title: string; description?: string | null }, fields: FormField[], dir?: string): Promise<Composed> {
  const out: Composed = { values: {}, log: [], rejected: [] };
  const usable = fields.filter((f) => ["text", "textarea", "select", "multiselect"].includes(f.type) && !/cover letter/i.test(f.label));
  for (const f of fields) if (!usable.includes(f)) out.rejected.push({ question: f.label, reason: "not a question the composer answers" });
  if (!usable.length) return out;

  const workDir = dir ?? join(DATA_DIR, "compose", job.id.replace(/\W+/g, "_"));
  mkdirSync(workDir, { recursive: true });
  const cache = join(workDir, "composed.json");
  const src = sources();
  const jd = (job.description ?? "").slice(0, 6000);

  const questions = usable.map((f) => ({
    key: f.key,
    question: f.label,
    kind: f.type === "textarea" ? "long text" : f.type === "text" ? "short text" : "dropdown",
    ...(f.options?.length ? { options: f.options.map((o) => o.label) } : {}),
  }));
  writeFileSync(join(workDir, "CLAUDE.md"), "# Composer\nFollow the prompt. Do not read or write any files.\n");
  const prompt = `${RULES}\n\n# Job\n${job.title} at ${job.company_name}\n${jd}\n\n# Material about Tanish\n${src.text}\n\n# Questions\n${JSON.stringify(questions, null, 1)}`;
  const run = await runClaudeCode({ cwd: workDir, prompt, allowedTools: ["Read"], maxTurns: 3, model: "sonnet", timeoutMs: 4 * 60_000 });
  if (!run.ok) {
    for (const f of usable) out.rejected.push({ question: f.label, reason: `composer failed: ${run.error ?? run.result.slice(0, 120)}` });
    return out;
  }
  let parsed: { key: string; answer: string | null }[] = [];
  try {
    parsed = JSON.parse(run.result.slice(run.result.indexOf("["), run.result.lastIndexOf("]") + 1));
  } catch {
    for (const f of usable) out.rejected.push({ question: f.label, reason: "composer reply wasn't JSON" });
    return out;
  }

  for (const f of usable) {
    const answer = parsed.find((p) => p.key === f.key)?.answer?.trim();
    if (!answer) {
      out.rejected.push({ question: f.label, reason: "needs a personal fact that isn't in your files" });
      continue;
    }
    if (f.options?.length) {
      const hit = matchOption(f.options, answer);
      if (!hit) {
        out.rejected.push({ question: f.label, reason: `answer "${answer}" isn't one of the options` });
        continue;
      }
      out.values[f.key] = f.type === "multiselect" ? [hit.value] : hit.value;
      out.log.push({ question: f.label, answer: hit.label });
      continue;
    }
    const problems = check(answer, f.label, jd, src.text, src.forbidden);
    if (problems.length) {
      out.rejected.push({ question: f.label, reason: problems.join("; ") });
      continue;
    }
    out.values[f.key] = answer;
    out.log.push({ question: f.label, answer });
  }
  writeFileSync(cache, JSON.stringify(out, null, 2));
  return out;
}
