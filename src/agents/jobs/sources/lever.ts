import type { BoardFetcher, Posting } from "../types.js";
import { getJson, htmlToText, NotFound } from "./http.js";

interface LeverPosting {
  id: string;
  text: string;
  createdAt?: number;
  hostedUrl: string;
  applyUrl: string;
  workplaceType?: string;
  categories?: { location?: string; allLocations?: string[]; team?: string; commitment?: string };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
}

export const lever: BoardFetcher = {
  ats: "lever",
  async fetchBoard(token) {
    let data: LeverPosting[];
    try {
      data = await getJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${token}?mode=json`);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    if (!Array.isArray(data)) return null;
    const postings: Posting[] = data.map((p) => {
      const locations = p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location ?? ""];
      const location = locations.filter(Boolean).join("; ");
      const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n");
      return {
        ats: "lever",
        boardToken: token,
        companyName: token,
        externalId: p.id,
        title: p.text.trim(),
        location,
        remote: p.workplaceType === "remote" || /remote/i.test(location),
        url: p.hostedUrl,
        applyUrl: p.applyUrl,
        postedAt: p.createdAt ?? null,
        description: [p.descriptionPlain ?? "", lists, p.additionalPlain ?? ""].join("\n").trim(),
      };
    });
    return { companyName: token, postings };
  },
};
