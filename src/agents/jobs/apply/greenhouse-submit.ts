import type { Page } from "playwright";

export type SubmitOutcome =
  | { kind: "submitted"; evidence: string }
  | { kind: "captcha" }
  | { kind: "code_timeout"; detail: string }
  | { kind: "invalid"; errors: string[] }
  | { kind: "unknown"; detail: string };

/** Fetches the emailed security code sent after `since` (epoch ms), or null if none arrives in time. */
export type CodeSource = (since: number) => Promise<string | null>;

const CODE_PROMPT = /verification code was sent|enter the \d+-character code|security code/i;

/** A wait that loses the race must never reject later (that would be an unhandled rejection). */
const quiet = <T>(p: Promise<T>): Promise<T> => p.catch(() => new Promise<T>(() => undefined));

const CONFIRMED = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received)|we.?ve received your application|successfully (applied|submitted)/i;

/** Click Submit, handle Greenhouse's emailed security code if asked, and classify what happened. Screenshots the result. */
export async function submitGreenhouse(page: Page, screenshotPath: string, getCode?: CodeSource): Promise<SubmitOutcome> {
  let clickedAt = Date.now();
  await page.getByRole("button", { name: /submit application/i }).click();
  let outcome = await waitForOutcome(page, true);

  if (outcome === "code") {
    if (!getCode) return finish(page, screenshotPath, { kind: "code_timeout", detail: "security code required but Gmail isn't connected" });
    const code = await getCode(clickedAt - 2_000);
    if (!code) return finish(page, screenshotPath, { kind: "code_timeout", detail: "no security code email within 3 minutes" });
    const entered = await enterCode(page, code);
    if (!entered.ok) return finish(page, screenshotPath, { kind: "unknown", detail: `couldn't enter the security code: ${entered.detail}` });
    clickedAt = Date.now();
    await page.getByRole("button", { name: /submit application/i }).click();
    outcome = await waitForOutcome(page, false);
  }
  return finish(page, screenshotPath, outcome === "code" ? { kind: "unknown", detail: "security code prompt still shown" } : outcome);
}

async function finish(page: Page, screenshotPath: string, outcome: SubmitOutcome): Promise<SubmitOutcome> {
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  return outcome;
}

async function waitForOutcome(page: Page, allowCode: boolean): Promise<SubmitOutcome | "code"> {
  const before = page.url();
  const races: Promise<SubmitOutcome | "code">[] = [
    new Promise((r) => setTimeout(() => r({ kind: "unknown", detail: "no confirmation, error, code prompt or challenge within 35s" }), 35_000)),
    quiet(
      page
        .waitForURL((u) => u.toString() !== before && /confirmation|thank/i.test(u.toString()), { timeout: 30_000 })
        .then((): SubmitOutcome => ({ kind: "submitted", evidence: `redirected to ${page.url()}` })),
    ),
    quiet(
      page
        .getByText(CONFIRMED)
        .first()
        .waitFor({ timeout: 30_000 })
        .then(async (): Promise<SubmitOutcome> => ({ kind: "submitted", evidence: ((await page.getByText(CONFIRMED).first().textContent()) ?? "").trim().slice(0, 120) })),
    ),
    quiet(
      page
        .locator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"]')
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then((): SubmitOutcome => ({ kind: "captcha" })),
    ),
    quiet(
      page
        .locator('.helper-text--error, [id$="-error"]:not(:empty)')
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(async (): Promise<SubmitOutcome> => {
          await page.waitForTimeout(500);
          const errors = await page.locator('.helper-text--error, [id$="-error"]:not(:empty)').allTextContents();
          return { kind: "invalid", errors: errors.map((e) => e.trim()).filter(Boolean).slice(0, 8) };
        }),
    ),
  ];
  if (allowCode) races.push(quiet(page.getByText(CODE_PROMPT).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => "code" as const)));
  return Promise.race(races);
}

/** The security-code boxes: one input per character, or a single input. Typed, then read back. */
async function enterCode(page: Page, code: string): Promise<{ ok: boolean; detail: string }> {
  const candidates = [
    page.locator('input[id^="security-input"]'),
    page.locator('input[aria-label*="security" i], input[name*="security" i], input[id*="security" i]'),
    page.getByText(/^security code/i).first().locator(`xpath=following::input[not(@type="hidden")][position()<=${code.length}]`),
  ];
  for (const boxes of candidates) {
    const n = await boxes.count();
    if (n !== code.length && n !== 1) continue;
    if (n === 1) {
      await boxes.first().fill(code);
    } else {
      await boxes.first().click();
      await page.keyboard.type(code, { delay: 60 });
      const typed = (await Promise.all(Array.from({ length: n }, (_, i) => boxes.nth(i).inputValue()))).join("");
      if (typed !== code) for (let i = 0; i < n; i++) await boxes.nth(i).fill(code[i]);
    }
    const value = n === 1 ? await boxes.first().inputValue() : (await Promise.all(Array.from({ length: n }, (_, i) => boxes.nth(i).inputValue()))).join("");
    return value === code ? { ok: true, detail: "entered" } : { ok: false, detail: `boxes show "${value}"` };
  }
  return { ok: false, detail: "security code inputs not found" };
}
