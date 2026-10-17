import type { BoardFetcher, Posting } from "../types.js";
import { getJson, htmlToText, NotFound } from "./http.js";

/**
 * Oracle Recruiting Cloud ("Candidate Experience" sites — JPMorgan, Honeywell, Amex, Oracle, DTCC, ...).
 * Token: "<host>|<siteNumber>", e.g. "jpmc.fa.oraclecloud.com|CX_1001".
 */
interface OrcReq {
  Id: string;
  Title: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  WorkplaceType?: string;
  ShortDescriptionStr?: string;
  ExternalQualificationsStr?: string;
  ExternalResponsibilitiesStr?: string;
  secondaryLocations?: { Name?: string }[];
}

const PAGE = 25; // the API caps pages at 25
const MAX_PAGES = 40;

export function parseOracleToken(token: string): { host: string; site: string } {
  const [host, site] = token.split("|");
  return { host, site };
}

export const oracle: BoardFetcher = {
  ats: "oracle",
  async fetchBoard(token, opts) {
    const { host, site } = parseOracleToken(token);
    const postings: Posting[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      let data: { items?: { TotalJobsCount: number; requisitionList: OrcReq[] }[] };
      try {
        data = await getJson(
          `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true` +
            `&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${site},limit=${PAGE},offset=${page * PAGE},sortBy=POSTING_DATES_DESC`,
        );
      } catch (e) {
        if (e instanceof NotFound && page === 0) return null;
        throw e;
      }
      const list = data.items?.[0]?.requisitionList;
      if (!list) return page === 0 ? null : { companyName: host, postings };
      for (const r of list) {
        const locations = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l) => l.Name)].filter(Boolean).join("; ");
        const url = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`;
        postings.push({
          ats: "oracle",
          boardToken: token,
          companyName: host,
          externalId: r.Id,
          title: r.Title.trim(),
          location: locations,
          remote: /remote/i.test(r.WorkplaceType ?? "") || /remote/i.test(locations),
          url,
          applyUrl: url,
          postedAt: r.PostedDate ? Date.parse(r.PostedDate) || null : null,
          description: "",
        });
      }
      const last = list.at(-1);
      const reachedOld = last?.PostedDate && Date.parse(last.PostedDate) < opts.since;
      const allKnown = list.every((r) => opts.isKnown(r.Id));
      if (list.length < PAGE || reachedOld || allKnown) break;
    }
    return { companyName: host, postings };
  },
  async fetchDetails(token, externalId) {
    const { host, site } = parseOracleToken(token);
    const d = await getJson<{ items?: Record<string, string>[] }>(
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true` +
        `&finder=ById;Id=%22${externalId}%22,siteNumber=${site}`,
    );
    const it = d.items?.[0] ?? {};
    return {
      description: ["ExternalDescriptionStr", "ExternalResponsibilitiesStr", "ExternalQualificationsStr"].map((k) => htmlToText(it[k] ?? "")).join("\n").trim(),
    };
  },
};
