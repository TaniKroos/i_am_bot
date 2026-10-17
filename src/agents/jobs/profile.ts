import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { PROFILE_DIR } from "../../core/config.js";

export interface Profile {
  identity: Record<string, any>;
  facts: Record<string, any>;
  targeting: {
    experience_band_years: [number, number];
    max_min_years_required: number;
    titles_include: string[];
    titles_exclude: string[];
    skills: { strong: string[]; familiar: string[] };
  };
  resume: Record<string, any>;
}

let cached: Profile | undefined;

export function loadProfile(): Profile {
  cached ??= YAML.parse(readFileSync(join(PROFILE_DIR, "profile.yaml"), "utf8")) as Profile;
  return cached;
}
