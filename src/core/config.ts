import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const PROFILE_DIR = join(ROOT, "profile");
export const DB_PATH = join(DATA_DIR, "grokbot.db");

mkdirSync(DATA_DIR, { recursive: true });

export const USER_AGENT = "grokBot/0.1 (personal job search assistant)";
