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
}

const OTHER_COUNTRIES =
  /\b(united states|u\.s\.|usa|us\b|america|canada|united kingdom|uk\b|britain|europe|eu\b|germany|ireland|netherlands|france|spain|poland|australia|singapore|japan|israel|brazil|mexico)/i;
const DECLINE = /(don.?t wish|do not wish|decline|prefer not|not to (answer|disclose|say)|choose not)/i;

/** Pick the option that best matches a desired answer (exact → starts with → contains). */
export function matchOption(options: FieldOption[], wanted: string | string[]): FieldOption | undefined {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  const expanded = list.flatMap((w) => (/^no$/i.test(w) ? [w, "never", "have not", "i have not", "not"] : /^yes$/i.test(w) ? [w, "i have", "i am", "i will"] : [w]));
  for (const w of expanded) {
    const lw = w.toLowerCase().trim();
    const hit =
      options.find((o) => o.label.toLowerCase().trim() === lw) ??
      options.find((o) => o.label.toLowerCase().startsWith(lw)) ??
      options.find((o) => o.label.toLowerCase().includes(lw));
    if (hit) return hit;
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
  for (const e of ctx.bank) {
    if (new RegExp(e.match, "i").test(label)) {
      const ans = value(field, e.answer, "answer_bank");
      if (ans.kind === "ask" && e.fallback_options) return value(field, e.fallback_options, "answer_bank");
      return ans;
    }
  }

  // 2) Voluntary demographic questions: always decline.
  if (field.group === "eeoc" || /\b(gender|race|ethnic|hispanic|latino|veteran|disability|sexual orientation|pronoun|transgender)\b/i.test(L)) {
    const decline = field.options?.find((o) => DECLINE.test(o.label));
    if (decline && !field.required) return { kind: "value", value: decline.value, source: "eeo_decline", note: decline.label };
    if (/\bgender\b/.test(L) && f.gender) return value(field, f.gender, "profile", "owner answers when required");
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
  if (/preferred last name/.test(L)) return value(field, id.last_name, "profile");
  if (/preferred (first )?name|name you.?d prefer/.test(L)) return value(field, id.first_name, "profile");
  if (/e-?mail/.test(L) && !/confirm/.test(L) && field.type !== "checkbox" && field.type !== "select") return value(field, id.email, "profile");
  if (/phone|mobile/.test(L) && field.type !== "select") return value(field, id.phone, "profile");
  if (/linkedin/.test(L)) return id.links?.linkedin ? value(field, id.links.linkedin, "profile") : { kind: "skip", reason: "no LinkedIn" };
  if (/github/.test(L) && !/username/.test(L)) return id.links?.github ? value(field, id.links.github, "profile") : { kind: "skip", reason: "no GitHub" };
  if (/github username/.test(L)) return value(field, String(id.links?.github ?? "").split("/").pop() ?? "", "profile");
  if (/portfolio|personal (web)?site|^website/.test(L)) return id.links?.portfolio ? value(field, id.links.portfolio, "profile") : { kind: "skip", reason: "no site" };

  // 5) Work authorisation first (its wording mentions "country"/"location"), then location.
  if (/employment agreement|non-?compete|post-employment|restrictive covenant/.test(L)) return field.required ? { kind: "ask", question: label } : { kind: "skip", reason: "owner-specific" };
  if (/sponsor|visa/.test(L)) {
    const abroad = OTHER_COUNTRIES.test(L) || (!jobInIndia && !/india/.test(L));
    if (abroad) return f.work_authorization?.needs_sponsorship_outside_india ? value(field, "Yes", "profile", "needs sponsorship outside India") : { kind: "ask", question: label };
    return value(field, "No", "profile", "no sponsorship needed in India");
  }
  if (/(authori[sz]ed|eligible|legally|right) to work/.test(L)) {
    if (OTHER_COUNTRIES.test(L)) return value(field, "No", "profile", "not authorised outside India");
    if (/india/.test(L) || jobInIndia) return value(field, "Yes", "profile", "authorised in India");
    return { kind: "ask", question: label };
  }
  if (/^country( of residence)?$|country of residence|current country|which country do you (live|reside)|country (you|in which you) (live|reside|are based)|country in which you will be located/.test(L))
    return value(field, id.country, "profile");
  if (/^(current )?(city|location)$|current (city|location)|where are you (currently )?(located|based)|city and state.*(residence|live)|primary residence/.test(L) && field.type !== "checkbox")
    return value(field, field.type === "select" ? [id.city, id.state, id.country] : `${id.city}, ${id.state}, ${id.country}`, "profile");
  if (/^location\b/.test(L) && field.group === "location") return value(field, `${id.city}, ${id.state}, ${id.country}`, "profile");
  if (/preferred (work )?location/.test(L) && field.type !== "select") return value(field, "Open to any location in India", "profile");
  if (/relocat/.test(L)) return jobInIndia ? value(field, "Yes", "profile", "open anywhere in India") : { kind: "ask", question: label };
  if (/office|on-?site|hybrid|in-person|\bwfo\b/.test(L) && /willing|able|comfortable|open|ok|okay|commit|ready/.test(L))
    return jobInIndia ? value(field, "Yes", "profile") : { kind: "ask", question: label };

  // 6) Experience, notice, compensation.
  const lessMore = L.match(/(less|fewer|more) than (\d+(?:\.\d+)?) years?/);
  if (lessMore && /experience/.test(L)) {
    const n = Number(lessMore[2]);
    const yes = lessMore[1] === "more" ? f.total_experience_years > n : f.total_experience_years < n;
    return value(field, yes ? "Yes" : "No", "profile", `${f.total_experience_years} years`);
  }
  if (/years? of (professional |relevant |total |work )?experience|how many years/.test(L)) {
    if (field.type === "select" && field.options) {
      const o = matchYearsOption(field.options, f.total_experience_years);
      return o ? { kind: "value", value: o.value, source: "profile", note: o.label } : { kind: "ask", question: label };
    }
    // Skill-specific years ("years of Java") aren't in the profile.
    if (/years? of (professional |relevant |total |work )?experience\s*$|total|overall|how many years of (professional |work )?experience/.test(L)) return value(field, String(f.total_experience_years), "profile");
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
  if (/(university|college|school|institution)/.test(L) && !/high school/.test(L)) return value(field, f.university, "profile");
  if (/degree|qualification/.test(L)) return value(field, field.type === "select" ? ["Bachelor", "B.Tech", "B.E", "Bachelor's"] : f.degree, "profile");
  if (/graduat(ion|ed).*(year|date)|year of (graduation|passing)/.test(L)) return value(field, String(f.graduation_year), "profile");
  if (/\b(gpa|cgpa|grade)\b/.test(L)) return value(field, String(f.cgpa), "profile");

  // 8) History with this company.
  if (/(previously|ever|before|currently).*(work|employ|consult|intern|appl)|(worked|employed) (at|by|for)/.test(L) && L.includes(job.company.toLowerCase().split(/\s/)[0]))
    return value(field, "No", "profile", `never employed by ${job.company}`);
  if (/^(current|present)( or last)? (employer|company|firm)( name)?\??$|name of (your )?(current|present) (employer|company|firm)|current or last (payroll )?company name|current firm/.test(L))
    return value(field, f.current_employer, "profile");
  if (/current (job )?title|current (role|position|designation)/.test(L)) return value(field, f.current_title, "profile");

  // 9) Required consents to submit the application itself.
  if (field.required && /(privacy|consent|acknowledge|agree|terms|certify|accurate)/.test(L)) {
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
