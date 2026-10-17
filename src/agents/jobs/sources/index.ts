import type { Ats, BoardFetcher } from "../types.js";
import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import { oracle } from "./oracle.js";
import { smartrecruiters } from "./smartrecruiters.js";
import { workable } from "./workable.js";
import { workday } from "./workday.js";

export const fetchers: Record<Ats, BoardFetcher> = { greenhouse, lever, ashby, smartrecruiters, workable, workday, oracle };
