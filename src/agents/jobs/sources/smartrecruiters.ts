import type { BoardFetcher, Posting } from "../types.js";
import { getJson, htmlToText } from "./http.js";

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  company?: { identifier: string; name: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string };
}

const PAGE = 100;
const MAX_PAGES = 10;

/** Newest first; India + remote only (big SR boards like Bosch have 5000+ global postings). */
async function list(token: string, filter: string, opts: Parameters<BoardFetcher["fetchBoard"]>[1]): Promise<SrPosting[]> {
  const out: SrPosting[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<{ totalFound: number; content: SrPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=${PAGE}&offset=${page * PAGE}${filter}`,
    );
    out.push(...data.content);
    const last = data.content.at(-1);
    const reachedOld = last?.releasedDate && Date.parse(last.releasedDate) < opts.since;
    const allKnown = data.content.length > 0 && data.content.every((p) => opts.isKnown(p.id));
    if (data.content.length < PAGE || reachedOld || allKnown) break;
  }
  return out;
}

export const smartrecruiters: BoardFetcher = {
  ats: "smartrecruiters",
  async fetchBoard(token, opts) {
    // SmartRecruiters answers 200 with zero results for unknown companies; treat empty as not found.
    const probe = await getJson<{ totalFound: number }>(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=1`);
    if (!probe.totalFound) return null;
    const [india, remote] = await Promise.all([list(token, "&country=in", opts), list(token, "&locationType=REMOTE", opts)]);
    const seen = new Set<string>();
    let companyName = token;
    const postings: Posting[] = [];
    for (const p of [...india, ...remote]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      companyName = p.company?.name ?? companyName;
      const url = `https://jobs.smartrecruiters.com/${p.company?.identifier ?? token}/${p.id}`;
      postings.push({
        ats: "smartrecruiters",
        boardToken: token,
        companyName,
        externalId: p.id,
        title: p.name.trim(),
        location: p.location?.fullLocation ?? [p.location?.city, p.location?.country].filter(Boolean).join(", "),
        remote: Boolean(p.location?.remote),
        url,
        applyUrl: url,
        postedAt: p.releasedDate ? Date.parse(p.releasedDate) || null : null,
        description: "",
      });
    }
    return { companyName, postings };
  },
  async fetchDetails(token, externalId) {
    const d = await getJson<{ jobAd?: { sections?: Record<string, { text?: string }> } }>(
      `https://api.smartrecruiters.com/v1/companies/${token}/postings/${externalId}`,
    );
    const s = d.jobAd?.sections ?? {};
    return {
      description: ["jobDescription", "qualifications", "additionalInformation"].map((k) => htmlToText(s[k]?.text ?? "")).join("\n").trim(),
    };
  },
};
