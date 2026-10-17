import type { BoardFetcher, Posting } from "../types.js";
import { getJson, NotFound } from "./http.js";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  isListed?: boolean;
}

export const ashby: BoardFetcher = {
  ats: "ashby",
  async fetchBoard(token) {
    let data: { jobs?: AshbyJob[] };
    try {
      data = await getJson<{ jobs?: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    if (!Array.isArray(data.jobs)) return null;
    const postings: Posting[] = data.jobs
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const location = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean).join("; ");
        return {
          ats: "ashby",
          boardToken: token,
          companyName: token,
          externalId: j.id,
          title: j.title.trim(),
          location,
          remote: Boolean(j.isRemote) || j.workplaceType === "Remote" || /remote/i.test(location),
          url: j.jobUrl,
          applyUrl: j.applyUrl,
          postedAt: j.publishedAt ? Date.parse(j.publishedAt) || null : null,
          description: j.descriptionPlain ?? "",
        };
      });
    return { companyName: token, postings };
  },
};
