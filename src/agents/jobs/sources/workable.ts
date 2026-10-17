import { USER_AGENT } from "../../../core/config.js";
import type { BoardFetcher, Posting } from "../types.js";
import { getJson, htmlToText, NotFound, throttle } from "./http.js";

interface WorkableJob {
  shortcode: string;
  title: string;
  published?: string;
  remote?: boolean;
  workplace?: string;
  location?: { city?: string; region?: string; country?: string };
  locations?: { city?: string; region?: string; country?: string }[];
}

const MAX_PAGES = 10;

export const workable: BoardFetcher = {
  ats: "workable",
  async fetchBoard(token) {
    const results: WorkableJob[] = [];
    let nextPage: string | undefined;
    for (let page = 0, retries = 0; page < MAX_PAGES; page++) {
      await throttle("workable", 1500);
      const res = await fetch(`https://apply.workable.com/api/v3/accounts/${token}/jobs`, {
        method: "POST",
        headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [], ...(nextPage ? { token: nextPage } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return null;
      if (res.status === 429 && retries++ < 3) {
        await new Promise((r) => setTimeout(r, 10_000 * retries));
        page--;
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} for workable ${token}`);
      const data = (await res.json()) as { total: number; results: WorkableJob[]; nextPage?: string };
      results.push(...data.results);
      nextPage = data.nextPage;
      if (!nextPage) break;
    }
    // Workable answers for many dormant accounts; an empty board counts as not found.
    if (!results.length) return null;
    const postings: Posting[] = results.map((j) => {
      const locs = j.locations?.length ? j.locations : j.location ? [j.location] : [];
      const location = locs.map((l) => [l.city, l.region, l.country].filter(Boolean).join(", ")).join("; ");
      const url = `https://apply.workable.com/${token}/j/${j.shortcode}/`;
      return {
        ats: "workable",
        boardToken: token,
        companyName: token,
        externalId: j.shortcode,
        title: j.title.trim(),
        location,
        remote: Boolean(j.remote) || j.workplace === "remote",
        url,
        applyUrl: `${url}apply/`,
        postedAt: j.published ? Date.parse(j.published) || null : null,
        description: "",
      };
    });
    return { companyName: token, postings };
  },
  async fetchDetails(token, externalId) {
    try {
      await throttle("workable", 1500);
      const d = await getJson<{ description?: string; requirements?: string; benefits?: string }>(
        `https://apply.workable.com/api/v2/accounts/${token}/jobs/${externalId}`,
      );
      return { description: [d.description, d.requirements].map((h) => htmlToText(h ?? "")).join("\n").trim() };
    } catch (e) {
      if (e instanceof NotFound) return { description: "" };
      throw e;
    }
  },
};
