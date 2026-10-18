import type { Page } from "playwright";
import type { AnswerContext } from "./answers.js";
import type { Composed } from "./compose.js";
import type { SubmitOutcome } from "./greenhouse-submit.js";
import { AlreadyApplied, fillStep, isReview, nextStep, openApplication, submitWorkday, workdaySignIn, type WdField } from "./workday.js";

export type WorkdayResult =
  | { kind: "needs_user"; reason: string; screenshot: string }
  | { kind: "already_applied" }
  | { kind: "dry_run"; screenshot: string }
  | { kind: "outcome"; outcome: SubmitOutcome; screenshot: string };

/**
 * One Workday application end to end: open → sign in → fill each step → Review → (submit).
 * Questions the rules can't answer go to the composer for that step only. Any failure stops before Submit.
 */
export async function applyWorkday(
  page: Page,
  jobUrl: string,
  ctx: AnswerContext,
  opts: { submit: boolean; dir: string; email: string; nationalPhone: string; compose(fields: WdField[]): Promise<Composed>; beforeSubmit?(): void },
): Promise<WorkdayResult> {
  const shot = async (name: string) => {
    const path = `${opts.dir}/${name}.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => undefined);
    return path;
  };
  try {
    await openApplication(page, jobUrl);
  } catch (e) {
    if (e instanceof AlreadyApplied) return { kind: "already_applied" };
    return { kind: "needs_user", reason: `couldn't open the application: ${String(e).split("\n")[0]}`, screenshot: await shot("open-failed") };
  }
  const signIn = await workdaySignIn(page, opts.email);
  if (!signIn.ok) return { kind: "needs_user", reason: `🔑 ${signIn.reason}`, screenshot: await shot("sign-in") };

  const composed: Record<string, string | string[]> = {};
  const extras = { nationalPhone: opts.nationalPhone };
  for (let i = 0; i < 10 && !(await isReview(page)); i++) {
    let r = await fillStep(page, ctx, composed, extras);
    if (r.asks.length) {
      const c = await opts.compose(r.asks);
      Object.assign(composed, c.values);
      r = await fillStep(page, ctx, composed, extras);
      const why = new Map(c.rejected.map((x) => [x.question, x.reason]));
      if (r.asks.length)
        return {
          kind: "needs_user",
          reason: `Questions only you can answer (${r.step}):\n• ${r.asks.map((a) => (why.has(a.label) ? `${a.label}\n   ↳ ${why.get(a.label)}` : a.label)).join("\n• ")}`,
          screenshot: await shot(`step-${i}`),
        };
    }
    if (r.failed.length)
      return { kind: "needs_user", reason: `Couldn't fill (${r.step}): ${r.failed.map((f) => `${f.label.slice(0, 80)} (${f.error})`).join("; ")}`, screenshot: await shot(`step-${i}`) };
    const errs = await nextStep(page);
    if (errs.length) return { kind: "needs_user", reason: `${r.step} wasn't accepted: ${errs.join("; ").slice(0, 600)}`, screenshot: await shot(`step-${i}-errors`) };
  }
  if (!(await isReview(page))) return { kind: "needs_user", reason: "never reached the Review step", screenshot: await shot("stuck") };

  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(3000);
  const review = await shot("filled");
  if (!opts.submit) return { kind: "dry_run", screenshot: review };
  const after = `${opts.dir}/after-submit.png`;
  opts.beforeSubmit?.();
  return { kind: "outcome", outcome: await submitWorkday(page, after), screenshot: after };
}
