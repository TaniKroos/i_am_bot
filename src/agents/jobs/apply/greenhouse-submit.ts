import type { Page } from "playwright";

export type SubmitOutcome =
  | { kind: "submitted"; evidence: string }
  | { kind: "captcha" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "unknown"; detail: string };

/** A wait that loses the race must never reject later (that would be an unhandled rejection). */
const quiet = <T>(p: Promise<T>): Promise<T> => p.catch(() => new Promise<T>(() => undefined));

const CONFIRMED = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received)|we.?ve received your application|successfully (applied|submitted)/i;

/** Click Submit on a filled Greenhouse form and classify what happened. Screenshots the result. */
export async function submitGreenhouse(page: Page, screenshotPath: string): Promise<SubmitOutcome> {
  const before = page.url();
  await page.getByRole("button", { name: /submit application/i }).click();

  const outcome = await Promise.race([
    new Promise<SubmitOutcome>((r) => setTimeout(() => r({ kind: "unknown", detail: "no confirmation, error or challenge within 35s" }), 35_000)),
    quiet(page
      .waitForURL((u) => u.toString() !== before && /confirmation|thank/i.test(u.toString()), { timeout: 30_000 })
      .then((): SubmitOutcome => ({ kind: "submitted", evidence: `redirected to ${page.url()}` }))),
    quiet(page
      .getByText(CONFIRMED)
      .first()
      .waitFor({ timeout: 30_000 })
      .then(async (): Promise<SubmitOutcome> => ({ kind: "submitted", evidence: ((await page.getByText(CONFIRMED).first().textContent()) ?? "").trim().slice(0, 120) }))),
    quiet(page
      .locator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"]')
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then((): SubmitOutcome => ({ kind: "captcha" }))),
    quiet(page
      .locator('[aria-invalid="true"], .helper-text--error, [id$="-error"]:not(:empty)')
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(async (): Promise<SubmitOutcome> => {
        await page.waitForTimeout(500);
        const errors = await page.locator('.helper-text--error, [id$="-error"]:not(:empty)').allTextContents();
        return { kind: "invalid", errors: errors.map((e) => e.trim()).filter(Boolean).slice(0, 8) };
      })),
  ]);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  return outcome;
}
