import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { DATA_DIR } from "../../../core/config.js";

/**
 * The bot's own browser: the installed Google Chrome with a separate, persistent profile in data/browser-profile.
 * Logins and cookies survive restarts; the owner's everyday Chrome profile is never touched.
 */
let ctx: BrowserContext | undefined;

export async function botBrowser(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  ctx ??= await chromium.launchPersistentContext(join(DATA_DIR, "browser-profile"), {
    channel: "chrome",
    headless: opts.headless ?? false,
    viewport: { width: 1280, height: 900 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });
  return ctx;
}

export async function closeBotBrowser(): Promise<void> {
  await ctx?.close();
  ctx = undefined;
}
