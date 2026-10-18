import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { DATA_DIR } from "../../../core/config.js";

/**
 * The bot's own browser: the installed Google Chrome with a separate, persistent profile in data/browser-profile.
 * Logins and cookies survive restarts; the owner's everyday Chrome profile is never touched.
 * The owner signs in to Google there once with plain Chrome (`bot browser-login`), and the bot reuses that session.
 */
export const BROWSER_PROFILE = join(DATA_DIR, "browser-profile");
const IDLE_CLOSE_MS = 2 * 60_000;

let ctx: BrowserContext | undefined;
let idleTimer: NodeJS.Timeout | undefined;

export async function botBrowser(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  if (!ctx) {
    ctx = await chromium.launchPersistentContext(BROWSER_PROFILE, {
      channel: "chrome",
      headless: opts.headless ?? false,
      viewport: { width: 1280, height: 900 },
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      // Playwright's mock keychain can't decrypt cookies saved by normal Chrome, which would drop the owner's
      // Google login; and with sync disabled, passwords saved to the Google account aren't offered for autofill.
      ignoreDefaultArgs: ["--use-mock-keychain", "--disable-sync"],
    });
    ctx.on("close", () => (ctx = undefined));
    // Free the profile when nothing is open, so the owner can open it in plain Chrome (bot browser-login).
    clearInterval(idleTimer);
    let idleSince = Date.now();
    idleTimer = setInterval(() => {
      if (!ctx) return clearInterval(idleTimer);
      if (ctx.pages().some((p) => p.url() !== "about:blank")) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_CLOSE_MS) void closeBotBrowser();
    }, 15_000);
    idleTimer.unref();
  }
  return ctx;
}

export async function closeBotBrowser(): Promise<void> {
  clearInterval(idleTimer);
  const c = ctx;
  ctx = undefined;
  await c?.close().catch(() => undefined);
}
