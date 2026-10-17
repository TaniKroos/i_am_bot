import type { Page } from "playwright";
import { answerField, type AnswerContext } from "./answers.js";
import type { ApplicationPlan, FieldType, FormField, PlannedField } from "./types.js";

export interface FillReport {
  url: string;
  filled: { label: string; value: string }[];
  failed: { label: string; error: string }[];
  skipped: { label: string; reason: string }[];
  captcha: "none" | "invisible" | "challenge";
  screenshot: string;
}

const esc = (id: string) => `[id="${id.replace(/"/g, '\\"')}"]`;

/**
 * Greenhouse dropdowns are comboboxes: focus, type the option label, pick the matching option,
 * then read back what the page shows. Typing "Male" also lists "Female", so exact matches win and
 * any mismatch after selection is an error, never a silent wrong answer.
 */
async function pickOption(page: Page, id: string, label: string): Promise<void> {
  const input = page.locator(esc(id));
  await input.click();
  await input.fill("");
  await input.pressSequentially(label.slice(0, 40), { delay: 15 });
  const exact = page.getByRole("option", { name: label, exact: true });
  await exact.or(page.getByRole("option", { name: label })).first().waitFor({ state: "visible", timeout: 5000 });
  const option = (await exact.count()) ? exact.first() : page.getByRole("option", { name: label }).first();
  await option.click();

  const shown = await selectedText(page, id);
  if (shown.toLowerCase() !== label.toLowerCase()) throw new Error(`picked "${shown}" but wanted "${label}"`);
}

/** The value a Greenhouse combobox currently displays. */
async function selectedText(page: Page, id: string): Promise<string> {
  const control = page.locator(esc(id)).locator("xpath=ancestor::*[contains(@class,'select__control')][1]");
  const single = control.locator(".select__single-value");
  if (await single.count()) return ((await single.first().textContent()) ?? "").trim();
  const multi = control.locator(".select__multi-value");
  return (await multi.allTextContents()).map((t) => t.trim()).join(", ");
}

function optionLabel(p: PlannedField, value: string): string {
  return p.field.options?.find((o) => o.value === value)?.label ?? value;
}

async function fillField(page: Page, p: PlannedField): Promise<string> {
  if (p.answer.kind !== "value") throw new Error("no value");
  const { field } = p;
  const value = p.answer.value;
  const el = page.locator(esc(field.key));
  if ((await el.count()) === 0) throw new Error(`field #${field.key} not on page`);

  switch (field.type) {
    case "file": {
      // Greenhouse's uploader only accepts files through its Attach button's file chooser.
      const name = String(value).split("/").pop()!;
      const attach = el.locator("xpath=..").locator("button", { hasText: /^\s*attach\s*$/i }).first();
      const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), attach.click()]);
      // Confirmed when the file lands in Greenhouse's S3 bucket (201 Created).
      const stored = page.waitForResponse((r) => /amazonaws\.com/.test(r.url()) && r.request().method() === "POST", { timeout: 30_000 });
      await chooser.setFiles(String(value));
      const res = await stored.catch(() => null);
      if (!res || res.status() !== 201) throw new Error(`upload not confirmed (S3 ${res?.status() ?? "no response"})`);
      return name;
    }
    case "select": {
      const label = optionLabel(p, String(value));
      await pickOption(page, field.key, label);
      return label;
    }
    case "multiselect": {
      const labels = (Array.isArray(value) ? value : [value]).map((v) => optionLabel(p, v));
      for (const l of labels) await pickOption(page, field.key, l);
      return labels.join(", ");
    }
    case "checkbox":
      await el.check();
      return "checked";
    default:
      await el.fill(Array.isArray(value) ? value.join(", ") : value);
      return Array.isArray(value) ? value.join(", ") : value;
  }
}

/** Fill a Greenhouse application. Never clicks Submit: submitting is a separate, gated step. */
export async function fillGreenhouse(
  page: Page,
  job: { boardToken: string; externalId: string },
  plan: ApplicationPlan,
  extras: { city: string; country: string; phone: string },
  answerCtx: AnswerContext,
  screenshotPath: string,
): Promise<FillReport> {
  const url = `https://job-boards.greenhouse.io/embed/job_app?for=${job.boardToken}&token=${job.externalId}`;
  // Wait for the form's scripts to finish loading: uploading before then fails inside Greenhouse's uploader.
  await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => page.waitForLoadState("domcontentloaded"));
  await page.locator(esc("first_name")).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);

  const report: FillReport = { url, filled: [], failed: [], skipped: [], captcha: "none", screenshot: screenshotPath };

  for (const p of plan.fields) {
    const label = p.field.label.slice(0, 70);
    if (p.answer.kind !== "value") {
      report.skipped.push({ label, reason: p.answer.kind === "skip" ? p.answer.reason : "needs owner" });
      continue;
    }
    if (p.field.group === "location") {
      report.skipped.push({ label, reason: "filled via the location box" });
      continue;
    }
    try {
      report.filled.push({ label, value: await fillField(page, p) });
    } catch (e) {
      report.failed.push({ label, error: String(e).split("\n")[0].slice(0, 160) });
    }
  }

  // Page-level widgets that aren't in the question list: phone country and the location autocomplete.
  // Phone country code: typing the number with +91 sets it; only pick it by hand if the page didn't.
  const phone = page.locator(esc("phone"));
  if (await phone.count()) await phone.fill(extras.phone);
  if (await page.locator(esc("country")).count()) {
    let shown = await selectedText(page, "country");
    if (!shown.includes("+91")) {
      try {
        const input = page.locator(esc("country"));
        await input.click();
        await input.pressSequentially(extras.country, { delay: 15 });
        await page.getByRole("option", { name: new RegExp(`^${extras.country}\\b`) }).first().click();
        shown = await selectedText(page, "country");
      } catch {
        /* reported below */
      }
    }
    if (shown.includes("+91")) report.filled.push({ label: "Phone country code", value: shown });
    else report.failed.push({ label: "Phone country code", error: `shows "${shown}", expected +91` });
  }
  const loc = page.locator(esc("candidate-location"));
  if (await loc.count()) {
    try {
      await loc.click();
      await loc.pressSequentially(extras.city, { delay: 30 });
      const opt = page.getByRole("option").filter({ hasText: extras.city }).first();
      await opt.waitFor({ state: "visible", timeout: 8000 });
      const text = (await opt.textContent())?.trim() ?? extras.city;
      await opt.click();
      report.filled.push({ label: "Location (City)", value: text });
    } catch (e) {
      report.failed.push({ label: "Location (City)", error: String(e).split("\n")[0] });
    }
  }

  // Sweep: required fields the question API didn't list (demographic blocks, consents) or that are still empty.
  for (const r of await requiredEmpty(page)) {
    const field: FormField = { key: r.id, label: r.label, type: r.type, required: true, group: r.label.match(/gender|race|ethnic|veteran|disab/i) ? "eeoc" : undefined };
    if (r.type === "select") field.options = await readOptions(page, r.id);
    const ans = answerField(field, answerCtx);
    if (ans.kind !== "value") {
      report.failed.push({ label: r.label, error: ans.kind === "ask" ? "needs owner answer" : ans.reason });
      continue;
    }
    try {
      report.filled.push({ label: `${r.label} (sweep)`, value: await fillField(page, { field, answer: ans }) });
    } catch (e) {
      report.failed.push({ label: r.label, error: String(e).split("\n")[0].slice(0, 160) });
    }
  }
  for (const r of await requiredEmpty(page)) report.failed.push({ label: r.label, error: "still empty after fill" });

  // reCAPTCHA: an invisible badge is normal; a visible challenge frame means a human is needed.
  const challenge = page.frameLocator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"]');
  const hasChallenge = (await page.locator('iframe[src*="bframe"], iframe[src*="hcaptcha"]').count()) > 0 && (await challenge.locator("body").isVisible().catch(() => false));
  report.captcha = hasChallenge ? "challenge" : (await page.locator('iframe[src*="recaptcha"]').count()) ? "invisible" : "none";

  await page.screenshot({ path: screenshotPath, fullPage: true });
  return report;
}

/** Required inputs that are still empty, read from the page (passed as a string so tooling can't rewrite it). */
async function requiredEmpty(page: Page): Promise<{ id: string; label: string; type: FieldType }[]> {
  return page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('[aria-required="true"], input[required], textarea[required]')) {
      if (!el.id || el.type === "hidden" || el.closest('[aria-hidden="true"]')) continue;
      const labelEl = document.getElementById(el.id + "-label") || document.querySelector('label[for="' + el.id + '"]');
      const label = ((labelEl && labelEl.textContent) || el.getAttribute("aria-label") || el.id).replace(/\\*/g, "").trim();
      if (el.getAttribute("role") === "combobox") {
        const control = el.closest(".select__control");
        const chosen = control && control.querySelector(".select__single-value, .select__multi-value");
        if (!chosen && el.id !== "candidate-location" && el.id !== "country") out.push({ id: el.id, label, type: "select" });
      } else if (el.type === "checkbox") {
        if (!el.checked) out.push({ id: el.id, label, type: "checkbox" });
      } else if (el.type === "file") {
        continue;
      } else if (!el.value) {
        out.push({ id: el.id, label, type: el.tagName === "TEXTAREA" ? "textarea" : "text" });
      }
    }
    for (const box of document.querySelectorAll('input[type="checkbox"]')) {
      const label = document.querySelector('label[for="' + box.id + '"]');
      const text = (label && label.textContent) || "";
      if (!box.checked && /\\*\\s*$/.test(text.trim()) && !out.some((o) => o.id === box.id)) out.push({ id: box.id, label: text.replace(/\\*/g, "").trim(), type: "checkbox" });
    }
    return out;
  })()`);
}

/** Open a combobox, read its option labels, close it. */
async function readOptions(page: Page, id: string): Promise<{ label: string; value: string }[]> {
  const input = page.locator(esc(id));
  await input.click();
  const labels = await page.getByRole("option").allTextContents().catch(() => [] as string[]);
  await page.keyboard.press("Escape");
  return labels.map((l) => ({ label: l.trim(), value: l.trim() }));
}
