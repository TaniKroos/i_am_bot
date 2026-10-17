import type { Ats, BoardFetcher } from "../types.js";
import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";

export const fetchers: Record<Ats, BoardFetcher> = { greenhouse, lever, ashby };
