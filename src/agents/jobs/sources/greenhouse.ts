import type { BoardFetcher, Posting } from "../types.js";
import { decodeEntities, getJson, htmlToText, NotFound } from "./http.js";

interface GhJob {
  id: number;
  title: string;
  updated_at: string;
  first_published?: string;
  location?: { name?: string };
  absolute_url: string;
  content?: string;
  company_name?: string;
}

export const greenhouse: BoardFetcher = {
  ats: "greenhouse",
  async fetchBoard(token) {
    let board: { name?: string };
    let data: { jobs: GhJob[] };
    try {
      [board, data] = await Promise.all([
        getJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${token}`),
        getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`),
      ]);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    const companyName = (board.name ?? token).replace(/\s+(job board|careers)$/i, "").trim();
    const postings: Posting[] = data.jobs.map((j) => {
      const location = j.location?.name ?? "";
      return {
        ats: "greenhouse",
        boardToken: token,
        companyName: j.company_name ?? companyName,
        externalId: String(j.id),
        title: j.title.trim(),
        location,
        remote: /remote/i.test(location),
        url: j.absolute_url,
        applyUrl: j.absolute_url,
        postedAt: Date.parse(j.first_published ?? j.updated_at) || null,
        description: htmlToText(decodeEntities(j.content ?? "")),
      };
    });
    return { companyName, postings };
  },
};
