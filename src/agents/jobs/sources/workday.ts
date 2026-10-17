import { USER_AGENT } from "../../../core/config.js";
import { TemporarilyUnavailable, type BoardFetcher, type Posting } from "../types.js";
import { htmlToText } from "./http.js";

/**
 * Workday career sites ("<tenant>.wdN.myworkdayjobs.com/<site>"), via the public CXS JSON API the site itself uses.
 * Token: "<host>|<tenant>|<site>", e.g. "nvidia.wd5.myworkdayjobs.com|nvidia|NVIDIAExternalCareerSite".
 */
interface WdJob {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  remoteType?: string;
  bulletFields?: string[];
}

const PAGE = 20; // CXS caps pages at 20
const MAX_PAGES_FIRST = 25;
const MAX_PAGES = 10;
const DAY = 24 * 3600_000;

export function parseWorkdayToken(token: string): { host: string; tenant: string; site: string } {
  const [host, tenant, site] = token.split("|");
  return { host, tenant, site };
}

/** "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → approximate epoch ms. */
export function parsePostedOn(text: string | undefined, now = Date.now()): number | null {
  if (!text) return null;
  if (/today/i.test(text)) return now;
  if (/yesterday/i.test(text)) return now - DAY;
  const m = text.match(/(\d+)\+?\s*days?/i);
  return m ? now - Number(m[1]) * DAY : null;
}

async function cxs<T>(url: string, body?: unknown): Promise<T | null> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json", "accept-language": "en-US" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const location = res.headers.get("location") ?? "";
  if (res.status >= 300 && res.status < 400 && /maintenance/i.test(location)) throw new TemporarilyUnavailable(`Workday maintenance (${url})`);
  if (res.status === 404 || res.status === 422) return null;
  if (res.status === 503) throw new TemporarilyUnavailable(`Workday 503 (${url})`);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}

export const workday: BoardFetcher = {
  ats: "workday",
  async fetchBoard(token, opts) {
    const { host, tenant, site } = parseWorkdayToken(token);
    const base = `https://${host}/wday/cxs/${tenant}/${site}`;
    const postings: Posting[] = [];
    const anyKnown = (jobs: WdJob[]) => jobs.some((j) => opts.isKnown(j.externalPath));
    // TODO(verify after Workday maintenance): confirm CXS lists newest first for an empty search on most tenants;
    // the early stop on an already-seen posting relies on it.
    const maxPages = opts.firstPoll ? MAX_PAGES_FIRST : MAX_PAGES;
    for (let page = 0; page < maxPages; page++) {
      const data = await cxs<{ total: number; jobPostings: WdJob[] }>(`${base}/jobs`, {
        appliedFacets: {},
        limit: PAGE,
        offset: page * PAGE,
        searchText: "",
      });
      if (!data) return page === 0 ? null : { companyName: tenant, postings };
      for (const j of data.jobPostings) {
        if (!j.title || !j.externalPath) continue;
        postings.push({
          ats: "workday",
          boardToken: token,
          companyName: tenant,
          externalId: j.externalPath,
          title: j.title.trim(),
          location: j.locationsText ?? "",
          remote: /remote/i.test(`${j.remoteType ?? ""} ${j.locationsText ?? ""}`),
          url: `https://${host}/en-US/${site}${j.externalPath}`,
          applyUrl: `https://${host}/en-US/${site}${j.externalPath}/apply`,
          postedAt: parsePostedOn(j.postedOn),
          description: "",
        });
      }
      if (!data.jobPostings.length) break;
      const oldest = Math.min(...data.jobPostings.map((j) => parsePostedOn(j.postedOn) ?? Date.now()));
      if (data.jobPostings.length < PAGE || oldest < opts.since || anyKnown(data.jobPostings)) break;
    }
    return { companyName: tenant, postings };
  },
  async fetchDetails(token, externalId) {
    const { host, tenant, site } = parseWorkdayToken(token);
    const d = await cxs<{ jobPostingInfo?: { jobDescription?: string; location?: string; additionalLocations?: string[]; remoteType?: string } }>(
      `https://${host}/wday/cxs/${tenant}/${site}${externalId}`,
    );
    const info = d?.jobPostingInfo;
    const location = [info?.location, ...(info?.additionalLocations ?? [])].filter(Boolean).join("; ");
    return { description: htmlToText(info?.jobDescription ?? ""), location: location || undefined };
  },
};
