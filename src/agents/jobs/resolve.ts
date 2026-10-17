import { USER_AGENT } from "../../core/config.js";
import type { Ats } from "./types.js";

export interface BoardRef {
  ats: Ats;
  token: string;
}

const BROWSER_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 ${USER_AGENT}`;

/** Recognise a board from a job or careers URL without fetching anything. Oracle named sites need resolveUrl(). */
export function parseBoardUrl(raw: string): BoardRef | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const t = u.searchParams.get("for") ?? (parts[0] === "embed" ? null : parts[0]);
    return t ? { ats: "greenhouse", token: t.toLowerCase() } : null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return parts[0] ? { ats: "lever", token: parts[0].toLowerCase() } : null;
  if (host === "jobs.ashbyhq.com") return parts[0] ? { ats: "ashby", token: parts[0] } : null;
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    return parts[0] ? { ats: "smartrecruiters", token: parts[0] } : null;
  }
  if (host === "apply.workable.com") return parts[0] && parts[0] !== "api" ? { ats: "workable", token: parts[0].toLowerCase() } : null;
  const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    // /en-US/<site>/job/... or /<site>/job/...
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts.slice(1) : parts;
    return rest[0] ? { ats: "workday", token: `${host}|${wd[1]}|${rest[0]}` } : null;
  }
  if (host.endsWith(".oraclecloud.com")) {
    const i = parts.indexOf("sites");
    const site = i >= 0 ? parts[i + 1] : undefined;
    if (site && /^CX_\d+$/.test(site)) return { ats: "oracle", token: `${host}|${site}` };
  }
  return null;
}

/** Resolve any URL to a board, fetching the page when needed (custom careers domains, Oracle named sites). */
export async function resolveUrl(raw: string): Promise<BoardRef | null> {
  const direct = parseBoardUrl(raw);
  if (direct) return direct;

  let html: string;
  let finalUrl = raw;
  try {
    const res = await fetch(raw, { headers: { "user-agent": BROWSER_UA, accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
    finalUrl = res.url;
    html = await res.text();
  } catch {
    return null;
  }
  const fromFinal = parseBoardUrl(finalUrl);
  if (fromFinal) return fromFinal;

  // Oracle Candidate Experience page (own domain or named site): the real host and siteNumber are in the HTML.
  const orcHost = html.match(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.oraclecloud\.com)\/hcmUI\/CandidateExperience/i)?.[1];
  const siteNumber = html.match(/siteNumber["'\s:=]+["']?(CX_\d+)/)?.[1] ?? html.match(/\b(CX_\d+)\b/)?.[1];
  if (orcHost && siteNumber) return { ats: "oracle", token: `${orcHost.toLowerCase()}|${siteNumber}` };

  // A company careers page that links out to a known ATS.
  const links = html.match(/https?:\/\/[^"'\s<>]+/g) ?? [];
  for (const link of links) {
    const ref = parseBoardUrl(link.replace(/&amp;/g, "&"));
    if (ref) return ref;
  }
  return null;
}
