export type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable" | "workday" | "oracle";

/** A posting normalised across careers systems. */
export interface Posting {
  ats: Ats;
  boardToken: string;
  companyName: string;
  externalId: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  applyUrl: string;
  /** Epoch ms from the source, when it says when the job was posted or last updated. */
  postedAt: number | null;
  /** May be empty for large boards; filled lazily by fetchDescription for postings that pass the title/location filter. */
  description: string;
}

export interface FetchOptions {
  /** True if we already stored this posting: lets newest-first boards stop paging early. */
  isKnown(externalId: string): boolean;
  /** Ignore postings older than this (epoch ms). */
  since: number;
  /** First poll of this board: big boards may page deeper to build the baseline. */
  firstPoll: boolean;
}

export interface BoardFetcher {
  ats: Ats;
  /** Returns null when the board does not exist on this ATS. */
  fetchBoard(token: string, opts: FetchOptions): Promise<{ companyName: string; postings: Posting[] } | null>;
  /** Full description (and real locations where the list only said e.g. "3 Locations"). */
  fetchDetails?(token: string, externalId: string): Promise<{ description: string; location?: string }>;
}

/** The careers site is temporarily unavailable (e.g. Workday maintenance): retry later, don't deactivate. */
export class TemporarilyUnavailable extends Error {}
