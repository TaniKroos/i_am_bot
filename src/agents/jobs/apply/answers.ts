import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { PROFILE_DIR } from "../../../core/config.js";
import type { Profile } from "../profile.js";
import type { Answer, AnswerSource, FieldOption, FormField } from "./types.js";

interface BankEntry {
  match: string;
  answer: string | string[];
  fallback_options?: string[];
}

export function loadAnswerBank(): BankEntry[] {
  const p = join(PROFILE_DIR, "answers.yaml");
  if (!existsSync(p)) return [];
  return (YAML.parse(readFileSync(p, "utf8"))?.answers ?? []) as BankEntry[];
}

export interface AnswerContext {
  profile: Profile;
  bank: BankEntry[];
  job: { company: string; title: string; location: string };
  /** Path of the tailored resume PDF to upload. */
  resumePdf: string | null;
  /** Applications at this company in the last 180 days (applied ledger: bot + Gmail). Unknown → history questions are asked. */
  history?: { companyApplications180d: number };
}

const OTHER_COUNTRIES =
  /\b(united states|u\.s\.|usa|us\b|america|canada|united kingdom|uk\b|britain|europe|eu\b|germany|ireland|netherlands|france|spain|poland|australia|singapore|japan|israel|brazil|mexico)/i;
const ACK = /^(yes|i (agree|acknowledge|accept|consent|confirm|understand|certify|have read)|agree|accept|acknowledged?|confirm(ed)?|understood)\b/i;
const DECLINE = /(don.?t wish|do not wish|decline|prefer not|not to (answer|disclose|say)|choose not)/i;

/** Pick the option that best matches a desired answer (exact → starts with → contains). */
export function matchOption(options: FieldOption[], wanted: string | string[]): FieldOption | undefined {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  const expanded = list
    .flatMap((w) => (/^no$/i.test(w) ? [w, "never", "have not", "i have not", "not"] : /^yes$/i.test(w) ? [w, "i have", "i am", "i will"] : [w]))
    .map((w) => w.toLowerCase().trim());
  const labels = options.map((o) => ({ o, l: o.label.toLowerCase().trim() }));
  const word = (w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  // Strongest match type first across all candidates, so a later exact match beats an earlier partial one.
  for (const test of [(l: string, w: string) => l === w, (l: string, w: string) => l.startsWith(w), (l: string, w: string) => word(w).test(l)]) {
    for (const w of expanded) {
      const hit = labels.find(({ l }) => test(l, w));
      if (hit) return hit.o;
    }
  }
  return undefined;
}

/** For "years of experience" dropdowns: the option whose range contains the owner's years. */
function matchYearsOption(options: FieldOption[], years: number): FieldOption | undefined {
  for (const o of options) {
    const nums = [...o.label.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    if (/less than|under|<|fewer/i.test(o.label) && nums.length && years < nums[0]) return o;
    if (nums.length >= 2 && years >= nums[0] && years <= nums[1]) return o;
    if (nums.length === 1 && /\+|more|above|over/i.test(o.label) && years >= nums[0]) return o;
  }
  return undefined;
}

function value(field: FormField, wanted: string | string[], source: AnswerSource, note?: string): Answer {
  if (field.type === "select" || field.type === "multiselect") {
    if (!field.options?.length) return { kind: "value", value: wanted, source, note };
    const hit = matchOption(field.options, wanted);
    if (!hit) return field.required ? { kind: "ask", question: `${field.label} (wanted "${wanted}", options: ${field.options.map((o) => o.label).slice(0, 8).join(" / ")})` } : { kind: "skip", reason: "no matching option" };
    return { kind: "value", value: field.type === "multiselect" ? [hit.value] : hit.value, source, note: note ?? hit.label };
  }
  if (field.type === "checkbox") return { kind: "value", value: wanted, source, note };
  return { kind: "value", value: Array.isArray(wanted) ? wanted.join(", ") : wanted, source, note };
}

export function answerField(field: FormField, ctx: AnswerContext): Answer {
  const { profile, job } = ctx;
  const id = profile.identity;
  const f = profile.facts;
  const label = field.label.replace(/\s+/g, " ").trim();
  const L = label.toLowerCase();
  const jobInIndia = /india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurgaon|gurugram|chennai|kolkata|ahmedabad|remote/i.test(job.location);

  if (field.type === "hidden") return { kind: "skip", reason: "hidden field (set by the page)" };

  // 1) The owner's own answers always win.
  const fill = (a: string | string[]) => (Array.isArray(a) ? a.map((x) => x.replace(/\{company\}/g, job.company)) : a.replace(/\{company\}/g, job.company));
  for (const e of ctx.bank) {
    if (new RegExp(e.match, "i").test(label)) {
      const ans = value(field, fill(e.answer), "answer_bank");
      if (!e.fallback_options) return ans;
      // Options unknown until the page is searched (Workday prompts): hand over the whole preference list.
      if ((field.type === "select" || field.type === "multiselect") && !field.options?.length)
        return { kind: "value", value: [fill(e.answer), fill(e.fallback_options)].flat(), source: "answer_bank" };
      if (ans.kind === "value") return ans;
      // Fallbacks in the owner's order: the first one that matches an option wins.
      for (const fb of fill(e.fallback_options) as string[]) {
        const a = value(field, fb, "answer_bank");
        if (a.kind === "value") return a;
      }
      return ans;
    }
  }

  // 2) Voluntary demographic questions: always decline.
  if (field.group === "eeoc" || /\b(gender|sex|race|ethnic|hispanic|latino|veteran|disability|sexual orientation|pronoun|transgender)\b/i.test(L)) {
    const decline = field.options?.find((o) => DECLINE.test(o.label));
    if (decline && !field.required) return { kind: "value", value: decline.value, source: "eeo_decline", note: decline.label };
    if (/\b(gender|sex)\b/.test(L) && f.gender) return value(field, f.gender, "profile", "owner answers when required");
    if (decline) return { kind: "value", value: decline.value, source: "eeo_decline", note: decline.label };
    return field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "voluntary demographic question" };
  }

  // 3) Files.
  if (field.type === "file") {
    if (/resume|cv/i.test(L)) return ctx.resumePdf ? { kind: "value", value: ctx.resumePdf, source: "resume" } : { kind: "ask", question: "tailored resume missing" };
    return field.required ? { kind: "ask", question: `${label} (file upload)` } : { kind: "skip", reason: "optional upload" };
  }
  if (/^(resume|cv)\b/i.test(L) && field.type === "textarea") return { kind: "skip", reason: "resume uploaded as a file instead" };
  if (/cover letter/i.test(L)) return field.required ? { kind: "ask", question: `${label} (cover letter required)` } : { kind: "skip", reason: "optional cover letter" };

  // 4) Identity and links.
  if (/^first name|given name/.test(L)) return value(field, id.first_name, "profile");
  if (/^last name|surname|family name/.test(L)) return value(field, id.last_name, "profile");
  if (/^(full |legal )?name$/.test(L)) return value(field, id.full_name, "profile");
  if (/i have a preferred name/.test(L)) return { kind: "skip", reason: "no preferred name" };
  if (/preferred last name/.test(L)) return value(field, id.last_name, "profile");
  if (/preferred (first )?name|name you.?d prefer/.test(L)) return value(field, id.first_name, "profile");
  if (/phone device type|phone type/.test(L)) return value(field, ["Mobile", "Cell", "Mobile Phone", "Personal Mobile"], "profile");
  if (/country phone code|phone country code|country code/.test(L)) return value(field, [`${id.country} (+${String(id.phone).match(/^\+(\d{1,3})/)?.[1] ?? "91"})`, id.country], "profile");
  if (/e-?mail/.test(L) && !/confirm/.test(L) && field.type !== "checkbox" && field.type !== "select") return value(field, id.email, "profile");
  if (/extension/.test(L) && /phone/.test(L)) return { kind: "skip", reason: "no phone extension" };
  if (/phone|mobile/.test(L) && field.type !== "select") return value(field, id.phone, "profile");
  if (/linkedin/.test(L)) return id.links?.linkedin ? value(field, id.links.linkedin, "profile") : { kind: "skip", reason: "no LinkedIn" };
  if (/github/.test(L) && !/username/.test(L)) return id.links?.github ? value(field, id.links.github, "profile") : { kind: "skip", reason: "no GitHub" };
  if (/github username/.test(L)) return value(field, String(id.links?.github ?? "").split("/").pop() ?? "", "profile");
  if (/portfolio|personal (web)?site|^website/.test(L)) return id.links?.portfolio ? value(field, id.links.portfolio, "profile") : { kind: "skip", reason: "no site" };

  // 5) Work authorisation first (its wording mentions "country"/"location"), then location.
  if (/employment agreement|non-?compete|post-employment|restrictive covenant/.test(L)) return field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "owner-specific" };
  // Free-text questions that ask for details deserve a sentence, not "Yes"/"No".
  const freeText = field.type === "text" || field.type === "textarea";
  if (freeText && /work authori[sz]ation|right to work|visa status/.test(L) && /(detail|describe|outline|explain|provide)/.test(L))
    return jobInIndia ? value(field, "Indian citizen, authorised to work in India. No sponsorship required for roles in India.", "profile") : { kind: "ask", question: label };
  if (freeText && /notice period/.test(L) && /(compensation|ctc|salary|package)/.test(L))
    return value(field, `${f.notice_period_days}-day notice period. Current CTC: ${f.current_ctc_lpa} LPA; expected: ${f.expected_ctc_answer ?? `${f.expected_ctc_lpa} LPA`}.`, "profile");
  // "List the countries where you need sponsorship" (free text, country names only as examples).
  if (/sponsor/.test(L) && /(indicate|list|separate each|which (countries|locations))/.test(L) && (field.type === "text" || field.type === "textarea"))
    return jobInIndia ? value(field, "Not applicable (N/A)", "profile", "seeking roles in India only") : { kind: "ask", question: label };
  if (/sponsor|visa/.test(L)) {
    const abroad = OTHER_COUNTRIES.test(L) || (!jobInIndia && !/india/.test(L));
    if (abroad) return f.work_authorization?.needs_sponsorship_outside_india ? value(field, "Yes", "profile", "needs sponsorship outside India") : { kind: "ask", question: label };
    return value(field, "No", "profile", "no sponsorship needed in India");
  }
  if (/citizen of the country (you are|you're) applying|citizen of (the )?country of (the )?(role|position|job)/.test(L)) return jobInIndia ? value(field, "Yes", "profile", "Indian citizen, India role") : { kind: "ask", question: label };
  if (/(authori[sz]ed|eligible|legally|right) to work|valid (work|residency|residence) permit/.test(L)) {
    if (OTHER_COUNTRIES.test(L)) return value(field, "No", "profile", "not authorised outside India");
    if (/india/.test(L) || jobInIndia) return value(field, "Yes", "profile", "authorised in India");
    return { kind: "ask", question: label };
  }
  if (/^country( of residence)?$|country of residence|current country|which country do you (live|reside)|country (you|in which you) (live|reside|are based)|country in which you will be located/.test(L))
    return value(field, id.country, "profile");
  // Split address forms (Workday): only from identity.address, so every part comes from the same address.
  const addr = id.address as { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string } | undefined;
  if (/^address line 1$|^street( address)?$/.test(L)) return addr?.line1 ? value(field, addr.line1, "profile") : field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "no address in profile" };
  if (/^address line 2$/.test(L)) return addr?.line2 ? value(field, addr.line2, "profile") : { kind: "skip", reason: "no second address line" };
  if (/^(postal|zip|pin) ?code$|^postcode$|^pin$/.test(L)) return addr?.postal_code ? value(field, addr.postal_code, "profile") : field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "no address in profile" };
  if (/^(current )?city$/.test(L) && field.type === "text") return value(field, addr?.city ?? id.city, "profile");
  if (/^(state|region|province|state ?\/ ?province)$/.test(L)) return value(field, field.type === "select" ? [addr?.state ?? id.state, `${addr?.state ?? id.state} (IN)`] : (addr?.state ?? id.state), "profile");
  if (/^(current )?(city|location)$|current (city|location)|where are you (currently )?(located|based)|city and state.*(residence|live)|primary residence/.test(L) && field.type !== "checkbox")
    return value(field, field.type === "select" ? [id.city, id.state, id.country] : `${id.city}, ${id.state}, ${id.country}`, "profile");
  if (/^location\b/.test(L) && field.group === "location") return value(field, `${id.city}, ${id.state}, ${id.country}`, "profile");
  if (/preferred (work )?location/.test(L) && field.type !== "select") return value(field, "Open to any location in India", "profile");
  if (/relocat/.test(L)) return jobInIndia ? value(field, "Yes", "profile", "open anywhere in India") : { kind: "ask", question: label };
  if (/alternat(iv)?e (contact )?(phone |mobile )?(number|phone)|other contact number/.test(L) && field.type !== "select") return value(field, id.phone, "profile", "only number on file");
  if (/\b(office|on-?site|hybrid|in-person|wfo)\b/.test(L.replace(/office hours/g, "")) && /\b(willing|able|comfortable|open|ok|okay|commit|ready)\b/.test(L))
    return jobInIndia ? value(field, "Yes", "profile") : { kind: "ask", question: label };

  // 6) Experience, notice, compensation.
  const lessMore = L.match(/(less|fewer|more) than (\d+(?:\.\d+)?) years?/);
  if (lessMore && /experience/.test(L)) {
    const n = Number(lessMore[2]);
    const yes = lessMore[1] === "more" ? f.total_experience_years > n : f.total_experience_years < n;
    return value(field, yes ? "Yes" : "No", "profile", `${f.total_experience_years} years`);
  }
  if (/years? of (professional |relevant |total |work )?experience|(relevant|total|overall) years of experience|how many years/.test(L)) {
    if (field.type === "select" && field.options) {
      const o = matchYearsOption(field.options, f.total_experience_years);
      return o ? { kind: "value", value: o.value, source: "profile", note: o.label } : { kind: "ask", question: label };
    }
    // Skill-specific years ("years of Java") aren't in the profile.
    if (/years? of (professional |relevant |total |work )?experience[\s.?]*$|total|overall|relevant years|how many years of (professional |work )?experience/.test(L)) return value(field, String(f.total_experience_years), "profile");
    return field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "skill-specific years not in profile" };
  }
  if (/notice period/.test(L)) return value(field, field.type === "select" ? ["30 days", "1 month", "30"] : "30 days", "profile");
  if (/(earliest|available to|availability|start date|when can you (start|join))/.test(L)) {
    const d = new Date(Date.now() + f.notice_period_days * 86_400_000);
    return value(field, field.type === "select" ? ["30 days", "1 month", "within 1 month"] : `After a ${f.notice_period_days}-day notice period (around ${d.toISOString().slice(0, 10)})`, "profile");
  }
  if (/current (ctc|salary|compensation|package)|current annual/.test(L)) return value(field, `${f.current_ctc_lpa} LPA`, "profile");
  if (/expected (ctc|salary|compensation|package)|salary expectation|desired (salary|compensation)/.test(L)) {
    if (/\$|usd|eur|gbp|£|€/i.test(L)) return { kind: "ask", question: label };
    return value(field, f.expected_ctc_answer ?? `${f.expected_ctc_lpa} LPA`, "profile");
  }

  // 7) Education.
  // Searchable school lists may hold the college, its short name, or only the affiliating university (GGSIPU).
  if (/(university|college|school|institution)/.test(L) && !/high school/.test(L))
    return value(field, field.type === "select" && !field.options?.length ? [f.university, ...(f.university_search ?? [])] : f.university, "profile");
  if (/degree|qualification/.test(L)) return value(field, field.type === "select" ? ["Bachelor", "B.Tech", "B.E", "Bachelor's"] : f.degree, "profile");
  if (/graduat(ion|ed).*(year|date)|year of (graduation|passing)/.test(L)) return value(field, String(f.graduation_year), "profile");
  if (/\b(gpa|cgpa|grade)\b/.test(L)) return value(field, String(f.cgpa), "profile");

  // 8) History with this company: from the applied ledger, never guessed.
  const co = job.company.toLowerCase().split(/\s/)[0];
  const aboutUs = L.includes(co) || /this (company|organi[sz]ation)|\bwith us\b/.test(L);
  if (aboutUs && /(active|current|pending|open|in-progress) application/.test(L)) {
    if (!ctx.history) return { kind: "ask", question: label };
    return value(field, ctx.history.companyApplications180d > 0 ? "Yes" : "No", "profile", `${ctx.history.companyApplications180d} application(s) at ${job.company} in 180 days`);
  }
  if (aboutUs && /(declined|rejected|unsuccessful|not (been )?selected|turned down)/.test(L)) {
    if (ctx.history?.companyApplications180d === 0) return value(field, "No", "profile", `no applications at ${job.company} in 180 days`);
    return { kind: "ask", question: label };
  }
  if (/(previously|ever|before|currently).*(work|employ|consult|intern|appl)|(worked|employed) (at|by|for)/.test(L) && (L.includes(job.company.toLowerCase().split(/\s/)[0]) || /this (company|organi[sz]ation)|\bus\b|previous worker|former (employee|worker)/.test(L)))
    return value(field, "No", "profile", `never employed by ${job.company}`);
  if (/^(current|present)( or last)? (employer|company|firm)( name)?\??$|name of (your )?(current|present) (employer|company|firm)|current or last (payroll )?company name|current firm/.test(L))
    return value(field, f.current_employer, "profile");
  if (/current (job )?title|current (role|position|designation)/.test(L)) return value(field, f.current_title, "profile");

  // 9) Consents. A required question whose only option is "I agree" / "I acknowledge" is a condition of applying.
  const ack = field.options?.length === 1 ? field.options.find((o) => ACK.test(o.label.trim())) : undefined;
  if (ack && (field.required || /(evaluat|consider).*(candidacy|application|roles|opportunit)/.test(L)) && (field.type === "select" || field.type === "multiselect"))
    return { kind: "value", value: field.type === "multiselect" ? [ack.value] : ack.value, source: "consent", note: ack.label };
  // Real consents only: "terms" also appears in questions like "as such terms are defined…".
  const question = /^(have|has|are|is|do|does|did|were|was|in the (last|past)|within|how|what|which|when|why|please (advise|indicate|confirm whether))\b/.test(L);
  if (field.required && !question && /(privacy (policy|notice|statement)|\bconsent\b|\backnowledge|\bi (agree|accept|certify|confirm|have read)|terms (and|&) conditions|terms of (use|service)|certify that|accurate and complete)/.test(L)) {
    if (field.type === "checkbox") return { kind: "value", value: "true", source: "consent", note: "required to submit" };
    const yes = field.options?.find((o) => /^(yes|i (agree|acknowledge|consent|confirm))/i.test(o.label));
    if (yes && (field.type === "select" || field.type === "multiselect"))
      return { kind: "value", value: field.type === "multiselect" ? [yes.value] : yes.value, source: "consent", note: yes.label };
  }
  if (/are you currently (working|employed)/.test(L)) return value(field, "Yes", "profile", `employed at ${f.current_employer}`);
  if (/how soon (can )?you (can )?(join|start)/.test(L)) return value(field, field.type === "select" ? ["30 days", "1 month"] : `${f.notice_period_days} days (notice period)`, "profile");
  if (/serving notice|last working day/.test(L)) return field.required ? value(field, "Not serving notice yet; 30-day notice period", "profile") : { kind: "skip", reason: "not serving notice" };

  // 10) Unknown.
  return field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "optional question with no known answer" };
}
