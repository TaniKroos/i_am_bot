export type Ats = "greenhouse" | "lever" | "ashby";

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
  description: string;
}

export interface BoardFetcher {
  ats: Ats;
  /** Returns null when the board does not exist on this ATS. */
  fetchBoard(token: string): Promise<{ companyName: string; postings: Posting[] } | null>;
}
