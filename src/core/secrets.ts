import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";

/**
 * Site passwords the bot created (e.g. a new Workday account), kept in the macOS Keychain, never in files.
 * Service "grokbot-site", account = the site's host. Visible to the owner in Keychain Access.
 */
const SERVICE = "grokbot-site";

export function getSitePassword(host: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", host, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function setSitePassword(host: string, password: string): void {
  execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", host, "-l", `grokBot: ${host}`, "-w", password], { stdio: "ignore" });
}

/** 20 characters with every class Workday-style rules ask for (upper, lower, digit, special). */
export function generatePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*-_?"];
  const all = sets.join("");
  const chars = [...sets.map((s) => s[randomInt(s.length)]), ...Array.from({ length: 16 }, () => all[randomInt(all.length)])];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
