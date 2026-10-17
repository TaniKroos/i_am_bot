import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PROFILE_DIR } from "../../core/config.js";
import { loadProfile } from "./profile.js";
import { ownerVocabulary, resumeGap, type Gap } from "./resume-gap.js";

/** Role families for tier-0 resumes. Briefs say what these roles ask for; the truth rules still decide what goes in. */
export const VARIANT_BRIEFS: Record<string, string> = {
  "ai-llm": `Titles: AI Engineer, Applied AI Engineer, GenAI / LLM Engineer, AI Agent Developer, Forward Deployed Engineer (AI).
They ask for: building LLM features into products, RAG and vector search, AI agents with tool calling, MCP,
evaluating model output quality, Python/FastAPI services around models, Azure OpenAI or Claude APIs,
taking AI from prototype to production, latency and reliability of AI services.`,
  backend: `Titles: Backend Engineer, Software Engineer (Backend), SDE I/II, Python Developer, .NET Developer.
They ask for: REST APIs and microservices, Python/FastAPI or C#/.NET (ASP.NET Core), relational databases
(PostgreSQL, SQL Server, MySQL) and Redis, performance and scalability, authentication (OAuth 2.0 / JWT),
Azure, Docker, CI/CD, code reviews, Agile/Scrum teams, owning services in production.`,
  fullstack: `Titles: Full-Stack Engineer, Software Engineer (Full Stack), Product Engineer.
They ask for: React and TypeScript frontends with Python/FastAPI or .NET backends, REST APIs, PostgreSQL,
authentication, shipping features end to end, browser extensions, testing, working across the stack.`,
  platform: `Titles: Platform Engineer, Infrastructure Engineer, SRE-leaning Software Engineer, Developer Platform Engineer.
They ask for: serverless (Azure Functions, Cloudflare Workers), Docker, CI/CD, horizontally scaled and crash-recoverable
services, Redis, connection pooling and latency optimisation, reliability, internal platforms used by many engineers.`,
};

export interface VariantRecord {
  name: string;
  pdf: string;
  tex: string;
  verdict: "ready" | "review" | "blocked";
  approved: boolean;
  builtAt: number;
}

const REGISTRY = join(DATA_DIR, "resume-variants", "registry.json");

export function loadVariants(): VariantRecord[] {
  return existsSync(REGISTRY) ? (JSON.parse(readFileSync(REGISTRY, "utf8")) as VariantRecord[]) : [];
}

export function saveVariant(v: VariantRecord): void {
  const all = loadVariants().filter((x) => x.name !== v.name);
  writeFileSync(REGISTRY, JSON.stringify([...all, v], null, 2));
}

export function approveVariant(name: string, approved = true): VariantRecord {
  const v = loadVariants().find((x) => x.name === name);
  if (!v) throw new Error(`no variant "${name}"`);
  if (approved && v.verdict !== "ready") throw new Error(`variant "${name}" failed its truth check (${v.verdict}); rebuild it first`);
  saveVariant({ ...v, approved });
  return { ...v, approved };
}

export interface ResumeChoice {
  name: string;
  pdf: string;
  tex: string;
  gap: Gap;
}

/** Tier 0: the base resume or an approved variant, whichever under-sells the owner least for this JD. */
export function pickResume(jdText: string): ResumeChoice {
  const baseTex = readFileSync(join(PROFILE_DIR, "resume.tex"), "utf8");
  const vocab = ownerVocabulary(baseTex, loadProfile());
  const candidates = [
    { name: "base", pdf: join(PROFILE_DIR, "Tanish_Resume.pdf"), tex: join(PROFILE_DIR, "resume.tex") },
    ...loadVariants().filter((v) => v.approved && v.verdict === "ready" && existsSync(v.pdf)),
  ];
  return candidates
    .map((c) => ({ name: c.name, pdf: c.pdf, tex: c.tex, gap: resumeGap(readFileSync(c.tex, "utf8"), jdText, vocab) }))
    .sort((a, b) => a.gap.gap - b.gap.gap)[0];
}
