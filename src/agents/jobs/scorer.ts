import type { Profile } from "./profile.js";
import type { Posting } from "./types.js";

export interface Score {
  score: number;
  /** Hard reasons the job is skipped regardless of score. */
  rejected: string | null;
  minYears: number | null;
  locationFit: "india" | "remote_india" | "remote_unclear" | "no";
  reasons: string[];
}

const INDIA = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|new delhi|ncr|noida|gurgaon|gurugram|chennai|kolkata|ahmedabad|jaipur|kochi|trivandrum|indore|chandigarh|coimbatore)\b/i;
const REMOTE_OK_REGION = /\b(apac|asia|anywhere|worldwide|global|emea\s*&\s*apac)\b/i;
const REMOTE_OTHER_REGION =
  /\b(us|usa|u\.s\.|united states|canada|uk|united kingdom|europe|eu|emea|latam|germany|france|spain|poland|netherlands|ireland|australia|brazil|mexico|japan|singapore|americas|north america|new york|san francisco|london|berlin|toronto)\b/i;

function wordMatch(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

/** Smallest "N years" figure stated near the word experience; null if the JD doesn't say. */
export function minYearsRequired(description: string): number | null {
  const re = /(\d{1,2})(?:\.\d)?\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)/gi;
  let min: number | null = null;
  for (const m of description.matchAll(re)) {
    const n = Number(m[1]);
    if (n > 15) continue;
    const window = description.slice(Math.max(0, m.index! - 80), m.index! + m[0].length + 80).toLowerCase();
    if (!/experien|professional|industry|working|engineering/.test(window)) continue;
    if (min === null || n < min) min = n;
  }
  return min;
}

function locationFit(p: Posting): Score["locationFit"] {
  const loc = p.location;
  if (INDIA.test(loc)) return p.remote ? "remote_india" : "india";
  if (p.remote || /remote/i.test(loc)) {
    if (REMOTE_OK_REGION.test(loc)) return "remote_india";
    if (REMOTE_OTHER_REGION.test(loc)) return "no";
    // Any other place named (e.g. "Korea", "Atlanta, GA") means remote within that place.
    const leftover = loc.replace(/\b(remote|hybrid|fully|friendly|first|only|work from home|wfh)\b|[-–,;()/|]/gi, "").trim();
    if (/[a-z]{2,}/i.test(leftover)) return "no";
    // Location says only "Remote": check the description for a country restriction.
    if (INDIA.test(p.description.slice(0, 3000))) return "remote_india";
    return "remote_unclear";
  }
  return "no";
}

export function scorePosting(p: Posting, profile: Profile): Score {
  const t = profile.targeting;
  const title = p.title.toLowerCase();
  const reasons: string[] = [];
  const result = (rejected: string | null, score = 0, minYears: number | null = null, loc: Score["locationFit"] = "no"): Score => ({
    score,
    rejected,
    minYears,
    locationFit: loc,
    reasons,
  });

  const excluded = t.titles_exclude.find((x) => wordMatch(title, x)) ?? (/\blead\b/.test(title) ? "lead" : undefined);
  if (excluded) return result(`title excludes "${excluded}"`);
  const included = t.titles_include.find((x) => wordMatch(title, x));
  if (!included && !/\bengineer\b|\bdeveloper\b/.test(title)) return result("title not a target role");

  const loc = locationFit(p);
  if (loc === "no") return result(`location "${p.location || "unknown"}" not India/remote-India`, 0, null, loc);

  const minYears = minYearsRequired(p.description);
  if (minYears !== null && minYears > t.max_min_years_required) return result(`needs ${minYears}+ years`, 0, minYears, loc);

  // With <2 years of experience, senior/level-3 roles only make sense when the JD itself asks for ≤2 years.
  const senior = /\b(senior|sr|sde\s*(iii|3)|(engineer|developer)\s*(iii|3)|level\s*3|l3)\b/i.test(title);
  if (senior && (minYears === null || minYears > 2)) return result("senior title without a ≤2y requirement", 0, minYears, loc);

  let score = included ? 45 : 35;
  reasons.push(included ? `title: ${included}` : "title: generic engineer");

  if (loc === "india") (score += 20), reasons.push("India location");
  else if (loc === "remote_india") (score += 20), reasons.push("remote, India eligible");
  else (score += 5), reasons.push("remote, region unclear");

  if (minYears === null) reasons.push("experience not stated");
  else if (minYears <= 3) (score += 15), reasons.push(`needs ${minYears}+ years`);

  const text = `${p.title}\n${p.description}`;
  const strong = t.skills.strong.filter((s) => wordMatch(text, s.toLowerCase()));
  const familiar = t.skills.familiar.filter((s) => wordMatch(text, s.toLowerCase()));
  const skillPoints = Math.min(25, strong.length * 4 + familiar.length * 2);
  score += skillPoints;
  if (strong.length) reasons.push(`skills: ${strong.slice(0, 6).join(", ")}`);

  if (senior) (score -= 10), reasons.push("senior title");
  if (/\b(junior|associate|sde\s*(i|1)|engineer\s*i\b|new grad|graduate)\b/i.test(title)) (score += 5), reasons.push("junior-friendly title");

  return result(null, Math.max(0, Math.min(100, score)), minYears, loc);
}
