import type { Page } from "playwright";
import { waitForMail } from "../../../core/google/gmail.js";
import { generatePassword, getSitePassword, setSitePassword } from "../../../core/secrets.js";
import { answerField, matchOption, type AnswerContext } from "./answers.js";
import type { SubmitOutcome } from "./greenhouse-submit.js";
import type { Answer, FieldOption, FieldType, FormField } from "./types.js";

/**
 * Workday ("myworkdayjobs.com") applications: one account per company site, then 4–6 steps
 * (My Information, My Experience, Application Questions, Voluntary Disclosures, Self Identify, Review).
 * Every field is a `formField-*` container; the widget inside decides how to fill it:
 *   button[aria-haspopup=listbox] → dropdown · multiSelectContainer → search prompt · radio / checkbox / text / textarea / file.
 * Values are read back after filling, like the Greenhouse filler.
 */

const A = (id: string) => `[data-automation-id="${id}"]`;
/** Options of the prompt that is open now (selected chips of other prompts use the same automation id). */
const OPEN_OPTIONS = `[data-automation-id="promptOption"]:not([data-automation-id="selectedItemList"] *)`;
const visible = (page: Page, sel: string) => page.locator(sel).first().isVisible().catch(() => false);

// ---------- Opening the application ----------

export class AlreadyApplied extends Error {
  constructor() {
    super("Workday says you've already applied to this job");
  }
}

/**
 * Job page → Apply. A first visit shows a popup (Autofill with Resume / Apply Manually / Use My Last Application);
 * with a saved draft or a live session Workday goes straight into the application instead.
 */
export async function openApplication(page: Page, jobUrl: string): Promise<void> {
  await page.goto(jobUrl, { waitUntil: "networkidle" });
  if (await page.getByText(/you('ve| have) already applied/i).first().isVisible().catch(() => false)) throw new AlreadyApplied();
  // "Apply" on a first visit; "Continue Application" when a draft exists.
  await page.locator(`${A("adventureButton")}, ${A("continueButton")}`).first().click({ timeout: 20_000 });
  const popup = page.locator(A("applyManually"));
  const flow = page.locator(`${A("applyFlowPage")}, ${A("signInFormo")}, ${A("signInContent")}`);
  await popup.or(flow).first().waitFor({ timeout: 20_000 });
  if (await popup.isVisible().catch(() => false)) {
    await popup.click();
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }
  await recoverErrorPage(page);
  // Steps load as a skeleton first: wait for a real form, a sign-in form or the error page.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = page.locator(`${A("pageFooterNextButton")}, ${A("signInFormo")}, ${A("email")}`).or(page.getByText(/something went wrong/i));
    await ready.first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    if (await page.getByText(/something went wrong/i).first().isVisible().catch(() => false)) await recoverErrorPage(page);
    else break;
  }
  await page.waitForTimeout(1000);
}

// ---------- Sign-in ----------

export type SignIn = { ok: true; how: "google" | "password" | "created" | "session" } | { ok: false; reason: string };

/** Google where offered, else the bot's Keychain password, else create an account. Accounts the bot can't open go to the owner. */
export async function workdaySignIn(page: Page, email: string): Promise<SignIn> {
  const host = new URL(page.url()).host;
  await dismissCookies(page);
  // Already inside the application (live session or a draft reopened on any step).
  if ((await visible(page, A("pageFooterNextButton"))) && !(await visible(page, A("signInFormo")))) return { ok: true, how: "session" };

  const google = page.locator(`${A("SignInWithGoogleButton")}, ${A("signInWithGoogle")}, button:has-text("Sign in with Google"), button:has-text("Continue with Google")`).first();
  if (await google.isVisible().catch(() => false)) {
    const popup = page.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null);
    await google.click();
    const p = await popup;
    if (p) {
      // Google account chooser: pick the owner's account; the session comes from `bot browser-login`.
      await p.locator(`[data-identifier="${email}"], div:has-text("${email}")`).first().click({ timeout: 15_000 }).catch(() => undefined);
      await p.locator('button:has-text("Continue"), button:has-text("Allow")').first().click({ timeout: 8000 }).catch(() => undefined);
      await p.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
    }
    if (await afterSignIn(page)) return { ok: true, how: "google" };
  }

  const saved = getSitePassword(host);
  if (saved) {
    await showSignInForm(page);
    await fillCredentials(page, email, saved, false);
    await submitAuth(page, "signInSubmitButton");
    if (await afterSignIn(page)) return { ok: true, how: "password" };
    const err = await authError(page);
    if (/verif/i.test(err) && (await verifyEmail(page, host))) {
      await fillCredentials(page, email, saved, false);
      await submitAuth(page, "signInSubmitButton");
      if (await afterSignIn(page)) return { ok: true, how: "password" };
    }
    return { ok: false, reason: `sign-in with the saved password failed${err ? `: ${err}` : ""}` };
  }

  // No password for this site: create the account (the owner's choice; the password goes to the Keychain first).
  if (await visible(page, A("createAccountLink"))) {
    await page.locator(A("createAccountLink")).first().click();
    await page.locator(A("verifyPassword")).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  if (!(await visible(page, A("verifyPassword")))) return { ok: false, reason: "no sign-in or create-account form found" };
  const pw = generatePassword();
  setSitePassword(host, pw);
  await fillCredentials(page, email, pw, true);
  await submitAuth(page, "createAccountSubmitButton");
  if (await afterSignIn(page)) return { ok: true, how: "created" };
  const err = await authError(page);
  if (/already|exists|in use/i.test(err)) return { ok: false, reason: `you already have an account on ${host} and it has no Google sign-in` };
  if (/verif/i.test(err) || (await visible(page, A("signInLink")))) {
    // Some sites email a verification link before the first sign-in.
    await verifyEmail(page, host);
    await showSignInForm(page);
    await fillCredentials(page, email, pw, false);
    await submitAuth(page, "signInSubmitButton");
    if (await afterSignIn(page)) return { ok: true, how: "created" };
  }
  return { ok: false, reason: `couldn't create an account on ${host}${err ? `: ${err}` : ""}` };
}

/** Switch the auth panel to "Sign In" (link marked signInLink on most sites, plain "Sign In" text on others). */
async function showSignInForm(page: Page): Promise<void> {
  if (await visible(page, A("signInSubmitButton"))) return;
  const link = page.locator(A("signInLink")).or(page.locator(A("signInContent")).getByRole("button", { name: "Sign In", exact: true })).or(page.locator(A("signInContent")).getByRole("link", { name: "Sign In", exact: true }));
  if (await link.first().isVisible().catch(() => false)) await link.first().click();
  else await page.locator(A("signInContent")).getByText("Sign In", { exact: true }).last().click().catch(() => undefined);
  // Wait for the form to switch: filling during the swap types into the create-account form.
  await page.locator(A("signInSubmitButton")).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

/** Cookie banners cover the auth buttons on some sites: decline them (accept only when there is no decline). */
async function dismissCookies(page: Page): Promise<void> {
  const decline = page.getByRole("button", { name: /^(decline|reject all|reject|decline all)$/i });
  const accept = page.getByRole("button", { name: /^(accept cookies|accept all|accept)$/i });
  if (await decline.first().isVisible().catch(() => false)) await decline.first().click().catch(() => undefined);
  else if (await accept.first().isVisible().catch(() => false)) await accept.first().click().catch(() => undefined);
}

async function fillCredentials(page: Page, email: string, password: string, create: boolean): Promise<void> {
  await page.locator(A("email")).first().fill(email);
  await page.locator(A("password")).first().fill(password);
  if (create) {
    await page.locator(A("verifyPassword")).first().fill(password);
    const cb = page.locator(A("createAccountCheckbox"));
    if (await cb.count()) await cb.first().check({ force: true }).catch(() => cb.first().click({ force: true }));
  }
}

/** Workday covers its auth buttons with a "click_filter" div; clicking that is what triggers the button. */
async function submitAuth(page: Page, button: string): Promise<void> {
  const wrapper = page.locator(A("noCaptchaWrapper")).filter({ has: page.locator(A(button)) }).first();
  const filter = wrapper.locator(A("click_filter")).first();
  if (await filter.count()) await filter.click({ force: true });
  else await page.locator(A(button)).first().click({ force: true });
}

async function afterSignIn(page: Page): Promise<boolean> {
  return page
    .locator(`${A("applyFlowMyInfoPage")}, ${A("applyFlowPage")} ${A("pageFooterNextButton")}`)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

async function authError(page: Page): Promise<string> {
  const t = await page.locator(`${A("errorMessage")}, [role="alert"]`).allInnerTexts().catch(() => []);
  return t.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Open the verification link Workday emails for a new account (Gmail, read-only). */
async function verifyEmail(page: Page, host: string): Promise<boolean> {
  const tenant = host.split(".")[0];
  const found = await waitForMail({
    // e.g. "guidewire@otp.workday.com" · "Verify your candidate account" · https://<host>/<site>/activate/<token>/
    query: `from:(otp.workday.com OR myworkday.com) (verify OR activate OR confirm)`,
    since: Date.now() - 3 * 86_400_000, // an unverified account may be retried days later
    timeoutMs: 150_000,
    extract: (m) => {
      const links = [...m.text.matchAll(/https:\/\/[^\s"'<>]+/g)].map((x) => x[0].replace(/&amp;/g, "&"));
      return links.find((l) => l.includes(tenant) && /verif|activat|confirm/i.test(l)) ?? null;
    },
  });
  if (!found) return false;
  const tab = await page.context().newPage();
  await tab.goto(found.value, { waitUntil: "networkidle" }).catch(() => undefined);
  await tab.close();
  await page.reload({ waitUntil: "networkidle" });
  return true;
}

// ---------- Reading a step ----------

type Kind = "dropdown" | "prompt" | "radio" | "checkbox" | "text" | "textarea" | "file" | "date" | "unknown";
export interface WdField extends FormField {
  kind: Kind;
  current: string;
}

const READ = `(() => {
  const out = [];
  for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
    if (!f.offsetParent) continue;
    const key = f.getAttribute('data-automation-id');
    if (f.parentElement && f.parentElement.closest('[data-automation-id^="formField-"]')) continue;
    const labelEl = f.querySelector('label, legend');
    const raw = labelEl ? labelEl.innerText : (f.getAttribute('aria-label') || '');
    const required = /\\*/.test(raw) || !!f.querySelector('[aria-required="true"], [required]');
    const label = raw.replace(/\\*/g, '').replace(/\\s+/g, ' ').trim();
    let kind = 'unknown', current = '', options = [];
    if (f.querySelector('button[aria-haspopup="listbox"]')) {
      kind = 'dropdown';
      const b = f.querySelector('button[aria-haspopup="listbox"]');
      current = /^select one$/i.test(b.innerText.trim()) ? '' : b.innerText.trim();
    } else if (f.querySelector('[data-automation-id="multiSelectContainer"]')) {
      kind = 'prompt';
      current = [...f.querySelectorAll('[data-automation-id="selectedItem"]')].map(e => e.innerText.trim()).join(', ');
    } else if (f.querySelector('input[type="radio"]')) {
      kind = 'radio';
      for (const r of f.querySelectorAll('input[type="radio"]')) {
        const l = document.querySelector('label[for="' + r.id + '"]');
        const t = (l ? l.innerText : r.value).trim();
        options.push({ label: t, value: r.id });
        if (r.checked) current = t;
      }
    } else if (f.querySelector('input[type="file"]')) {
      kind = 'file';
      current = [...f.querySelectorAll('[data-automation-id="file-upload-item"], [data-automation-id="fileName"]')].map(e => e.innerText.trim()).join(', ');
    } else if (f.querySelector('[data-automation-id="dateInputWrapper"], [role="spinbutton"]')) {
      kind = 'date';
    } else if (f.querySelector('input[type="checkbox"]')) {
      kind = 'checkbox';
      current = f.querySelector('input[type="checkbox"]').checked ? 'checked' : '';
    } else if (f.querySelector('textarea')) {
      kind = 'textarea';
      current = f.querySelector('textarea').value;
    } else if (f.querySelector('input[type="text"], input:not([type])')) {
      kind = 'text';
      current = f.querySelector('input[type="text"], input:not([type])').value;
    }
    out.push({ key, label, required, kind, current, options });
  }
  return out;
})()`;

const KIND_TYPE: Record<Kind, FieldType> = {
  dropdown: "select",
  prompt: "select",
  radio: "select",
  checkbox: "checkbox",
  text: "text",
  textarea: "textarea",
  file: "file",
  date: "text",
  unknown: "text",
};

export async function readStep(page: Page): Promise<WdField[]> {
  type Raw = { key: string; label: string; required: boolean; kind: Kind; current: string; options: FieldOption[] }[];
  // Sections render in stages after the step opens: read until the field list stops changing.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  let raw = (await page.evaluate(READ)) as Raw;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const again = (await page.evaluate(READ)) as Raw;
    const same = again.map((r) => r.key).join() === raw.map((r) => r.key).join();
    raw = again;
    if (same && raw.length) break;
  }
  const fields: WdField[] = [];
  for (const r of raw) {
    const f: WdField = { key: r.key, label: r.label, required: r.required, kind: r.kind, current: r.current, type: KIND_TYPE[r.kind], options: r.options.length ? r.options : undefined };
    if (/gender|ethnic|race|veteran|disabilit|hispanic|sexual|pronoun/i.test(r.label)) f.group = "eeoc";
    // Dropdown options only appear when opened: read them now so answers can be matched exactly.
    if (r.kind === "dropdown" && !r.current) f.options = await dropdownOptions(page, r.key);
    if (r.kind === "prompt" && !r.current) f.options = await promptOptions(page, r.key);
    fields.push(f);
  }
  return fields;
}

async function dropdownOptions(page: Page, key: string): Promise<FieldOption[]> {
  const button = page.locator(`${A(key)} button[aria-haspopup="listbox"]`).first();
  await button.click();
  const list = page.locator('[role="listbox"] [role="option"]');
  await list.first().waitFor({ timeout: 5000 }).catch(() => undefined);
  const labels = (await list.allInnerTexts().catch(() => [])).map((t) => t.trim()).filter((t) => t && !/^select one$/i.test(t));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return labels.map((l) => ({ label: l, value: l }));
}

/** Top-level options of a search prompt (empty for long lists that only answer a search). */
async function promptOptions(page: Page, key: string): Promise<FieldOption[] | undefined> {
  // Some prompts (skills, multi-select identities) hide their input until focused: no up-front options then.
  const opened = await page.locator(`${A(key)} input`).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
  if (!opened) return undefined;
  await page.locator(OPEN_OPTIONS).first().waitFor({ timeout: 3000 }).catch(() => undefined);
  const labels = (await page.locator(OPEN_OPTIONS).allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return labels.length ? labels.map((l) => ({ label: l, value: l })) : undefined;
}

// ---------- Filling ----------

export interface StepReport {
  step: string;
  filled: { label: string; value: string }[];
  failed: { label: string; error: string }[];
  skipped: { label: string; reason: string }[];
  asks: WdField[];
}

async function pickDropdown(page: Page, key: string, label: string): Promise<string> {
  const button = page.locator(`${A(key)} button[aria-haspopup="listbox"]`).first();
  await button.click();
  // Only the list this button opened (aria-controls), never an option left over from another dropdown.
  const listId = await button.getAttribute("aria-controls");
  const list = listId ? page.locator(`[id="${listId}"]`) : page.locator('[role="listbox"]:visible').last();
  const exact = list.getByRole("option", { name: label, exact: true });
  await exact.first().waitFor({ state: "visible", timeout: 5000 });
  await exact.first().click();
  await page.waitForTimeout(500);
  const shown = (await page.locator(`${A(key)} button[aria-haspopup="listbox"]`).first().innerText()).trim();
  if (shown.toLowerCase() !== label.toLowerCase()) throw new Error(`shows "${shown}", wanted "${label}"`);
  return shown;
}

/** Search prompt: type, pick the best option; categories ("Job Board ›") open a second level that is matched the same way. */
async function pickPrompt(page: Page, key: string, wanted: string[]): Promise<string> {
  const box = page.locator(`${A(key)} input`).first();
  const selected = () => page.locator(`${A(key)} ${A("selectedItem")}`).allInnerTexts();
  const opts = page.locator(OPEN_OPTIONS);
  // A wrong earlier pick (e.g. from a saved draft) hides the search box: remove it first.
  for (let i = 0; i < 5 && (await page.locator(`${A(key)} ${A("DELETE_charm")}`).count()); i++) {
    await page.locator(`${A(key)} ${A("DELETE_charm")}`).first().click();
    await page.waitForTimeout(500);
  }
  // Open once: clicking the box again would jump back to the top level of a category list.
  await box.click();
  await opts.first().waitFor({ timeout: 5000 }).catch(() => undefined);
  for (let level = 0; level < 3; level++) {
    await page.waitForTimeout(600);
    let labels = (await opts.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    if (!labels.length && level === 0) {
      // Long lists only show results after a search.
      await box.fill(wanted[0]);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
      labels = (await opts.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    }
    if (!labels.length) break;
    let options = labels.map((l) => ({ label: l, value: l }));
    // Preference order: the first wanted value that matches anything wins (a fallback "Other" never beats "Career site").
    let hit = wanted.map((w) => matchOption(options, w)).find(Boolean);
    if (!hit && level === 0) {
      // Searchable lists (schools, fields of study) show a few suggestions only: search for each wanted value,
      // and accept a result only when it clearly names it, never just the first result.
      for (const w of wanted) {
        const term = w.split(",")[0].trim();
        await box.fill(term);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1800);
        options = (await opts.allInnerTexts()).map((t) => t.trim()).filter(Boolean).map((l) => ({ label: l, value: l }));
        if (process.env.WD_DEBUG) console.log(`[prompt ${key}] "${term}" →`, options.map((o) => o.label).slice(0, 12));
        hit = matchOption(options, w) ?? matchOption(options, term) ?? options.find((o) => o.label.toLowerCase().includes(term.toLowerCase()));
        if (hit) break;
      }
      if (!hit) await page.keyboard.press("Escape").catch(() => undefined); // don't leave the popup over the next field
      if (!hit) throw new Error(`no option like "${wanted[0]}" after searching (results: ${options.map((o) => o.label).slice(0, 6).join(" / ") || "none"})`);
    }
    hit ??= level > 0 ? options[0] : undefined;
    if (!hit) throw new Error(`no option like "${wanted[0]}" (options: ${labels.slice(0, 8).join(" / ")})`);
    await opts.filter({ hasText: hit.label }).first().click();
    await page.waitForTimeout(800);
    const now = (await selected()).map((t) => t.trim());
    if (now.length) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return now.join(", ");
    }
  }
  throw new Error(`nothing selected for "${wanted[0]}"`);
}

async function fillOne(page: Page, f: WdField, answer: Answer & { kind: "value" }, extras: { nationalPhone: string }): Promise<string> {
  const root = page.locator(A(f.key)).first();
  const v = answer.value;
  const first = Array.isArray(v) ? v[0] : v;
  switch (f.kind) {
    case "dropdown":
      return pickDropdown(page, f.key, f.options?.find((o) => o.value === first)?.label ?? first);
    case "prompt": {
      const wanted = (Array.isArray(v) ? v : [v]).map((x) => f.options?.find((o) => o.value === x)?.label ?? x);
      return pickPrompt(page, f.key, wanted);
    }
    case "radio": {
      const id = f.options?.find((o) => o.value === first)?.value ?? f.options?.find((o) => o.label === first)?.value;
      if (!id) throw new Error(`no radio "${first}"`);
      const r = page.locator(`[id="${id}"]`);
      await r.check({ force: true });
      if (!(await r.isChecked())) throw new Error("radio did not stay checked");
      return f.options!.find((o) => o.value === id)!.label;
    }
    case "checkbox": {
      // Workday draws its own box over the input: try the input, then its label, then the drawn box.
      const c = root.locator('input[type="checkbox"]').first();
      const id = await c.getAttribute("id");
      const attempts = [
        () => c.check({ force: true, timeout: 5000 }),
        () => (id ? page.locator(`label[for="${id}"]`).first().click({ timeout: 5000 }) : Promise.reject(new Error("no label"))),
        () => c.locator("xpath=following-sibling::*[1]").click({ force: true, timeout: 5000 }),
        () => c.click({ force: true, timeout: 5000 }),
      ];
      for (const attempt of attempts) {
        if (await c.isChecked()) break;
        await attempt().catch(() => undefined);
        await page.waitForTimeout(300);
      }
      if (!(await c.isChecked())) throw new Error("checkbox did not stay checked");
      return "checked";
    }
    case "file": {
      // A saved draft keeps earlier uploads: end with exactly one copy of this resume attached.
      const name = String(first).split("/").pop()!;
      const names = () => page.locator(A("file-upload-item-name")).allInnerTexts().then((t) => t.map((x) => x.trim()));
      const existing = await names();
      if (existing.length === 1 && existing[0] === name) return `${name} (already attached)`;
      for (let i = 0; i < 15 && (await page.locator(A("delete-file")).count()); i++) {
        await page.locator(A("delete-file")).first().click();
        await page.waitForTimeout(1000);
      }
      if ((await names()).length) throw new Error("couldn't remove earlier attachments");
      const input = root.locator('input[type="file"]').first();
      await ((await input.count()) ? input : page.locator(A("file-upload-input-ref")).first()).setInputFiles(String(first));
      await page.locator(A("file-upload-successful")).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      const after = await names();
      if (after.length !== 1 || after[0] !== name) throw new Error(`attachments after upload: ${after.join(", ") || "none"}`);
      return name;
    }
    case "text":
    case "textarea": {
      const value = f.key === "formField-phoneNumber" ? extras.nationalPhone : Array.isArray(v) ? v.join(", ") : v;
      const input = root.locator(f.kind === "textarea" ? "textarea" : "input").first();
      await input.fill(value);
      await input.blur();
      const back = await input.inputValue();
      if (back !== value) throw new Error(`shows "${back}"`);
      return value;
    }
    default:
      throw new Error(`can't fill a ${f.kind} field yet`);
  }
}

/** Fill one step. Answers come from the rule engine, then `composed` (free-text written from experience.md). */
export async function fillStep(
  page: Page,
  ctx: AnswerContext,
  composed: Record<string, string | string[]>,
  extras: { nationalPhone: string },
): Promise<StepReport> {
  await recoverErrorPage(page);
  const step = (await page.locator(A("progressBarActiveStep")).first().innerText().catch(() => "")).split("\n").pop()?.trim() ?? "";
  const report: StepReport = { step, filled: [], failed: [], skipped: [], asks: [] };
  const done: { f: WdField; answer: Answer & { kind: "value" }; shown: string }[] = [];
  for (const f of await readStep(page)) {
    let answer = answerField(f, ctx);
    if (answer.kind === "ask" && composed[f.key] !== undefined) {
      const c = composed[f.key];
      // Composer answers for dropdowns are option values (= labels here); keep them as given.
      answer = { kind: "value", value: c, source: "composed" };
    }
    // Search prompts only list a few suggestions up front: if none matched, answer as if the options were unknown
    // and let pickPrompt search for the value.
    if (answer.kind === "ask" && f.kind === "prompt" && f.options?.length) {
      const searched = answerField({ ...f, options: undefined }, ctx);
      if (searched.kind === "value") answer = searched;
    }
    // The resume box on "My Experience" is labelled just "Upload a file".
    if (answer.kind === "ask" && f.kind === "file" && /experience/i.test(step) && ctx.resumePdf) answer = { kind: "value", value: ctx.resumePdf, source: "resume" };
    // Workday prefills from the account and earlier steps: keep a value that already matches.
    // A prompt answered from a preference list (e.g. "How did you hear") keeps whichever listed option was picked earlier.
    const preferenceList = answer.kind === "value" && answer.source === "answer_bank" && f.kind === "prompt" && Array.isArray(answer.value) && answer.value.length > 1;
    // Free text the rules can't answer is (re)written by the composer, even if a saved draft already has text.
    if (answer.kind === "ask" && f.current && (f.kind === "text" || f.kind === "textarea")) {
      report.asks.push(f);
      continue;
    }
    if (f.current && (answer.kind !== "value" || answerMatches(f, answer) || preferenceList)) {
      report.skipped.push({ label: f.label, reason: `already "${f.current.slice(0, 40)}"` });
      continue;
    }
    if (answer.kind === "skip") {
      report.skipped.push({ label: f.label, reason: answer.reason });
      continue;
    }
    if (answer.kind === "ask") {
      report.asks.push(f);
      continue;
    }
    try {
      const shown = await fillOne(page, f, answer, extras);
      report.filled.push({ label: f.label, value: shown });
      done.push({ f, answer, shown });
    } catch (e) {
      report.failed.push({ label: f.label, error: String(e).split("\n")[0].slice(0, 160) });
    }
  }

  // Workday re-renders a section when a later field changes, which can blank an earlier dropdown.
  // Read the whole step back and refill anything that lost its value (once); what still won't stick fails.
  await page.waitForTimeout(800);
  const now = new Map(((await page.evaluate(READ)) as { key: string; current: string }[]).map((r) => [r.key, r.current]));
  for (const { f, answer, shown } of done) {
    if (f.kind === "file" || f.kind === "checkbox") continue;
    const cur = now.get(f.key) ?? "";
    // Compare with what was actually picked ("HPE Careers webpage"), not only with the wanted text ("Career site").
    const picked = shown.toLowerCase();
    if (cur && (answerMatches({ ...f, current: cur }, answer) || cur.toLowerCase().includes(picked) || picked.includes(cur.toLowerCase()))) continue;
    // A prompt with a selection hides its search box: never try to reopen it.
    if (cur && f.kind === "prompt") continue;
    try {
      await fillOne(page, f, answer, extras);
      await page.waitForTimeout(500);
      const again = ((await page.evaluate(READ)) as { key: string; current: string }[]).find((r) => r.key === f.key)?.current ?? "";
      if (!again || !answerMatches({ ...f, current: again }, answer)) throw new Error(`lost its value again (shows "${again}")`);
    } catch (e) {
      report.filled = report.filled.filter((x) => x.label !== f.label);
      report.failed.push({ label: f.label, error: String(e).split("\n")[0].slice(0, 160) });
    }
  }
  return report;
}

function answerMatches(f: WdField, a: Answer & { kind: "value" }): boolean {
  const want = (Array.isArray(a.value) ? a.value : [a.value]).map((x) => (f.options?.find((o) => o.value === x)?.label ?? x).toLowerCase());
  const cur = f.current.toLowerCase();
  return want.some((w) => cur === w || cur.includes(w) || w.includes(cur));
}

/** Click "Save and Continue" (or Submit on the review page). Returns the page's validation errors, if any. */
export async function nextStep(page: Page): Promise<string[]> {
  const before = await page.locator(A("progressBarActiveStep")).first().innerText().catch(() => "");
  await page.locator(A("pageFooterNextButton")).first().click();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(750);
    const now = await page.locator(A("progressBarActiveStep")).first().innerText().catch(() => "");
    if (now && now !== before) return [];
  }
  // Still on the same step: collect the validation messages (their automation ids vary by tenant).
  const errs = await page.evaluate(`[...document.querySelectorAll('[data-automation-id*="rror"], [id$="-error"], [role="alert"]')]
    .filter(e => e.offsetParent).map(e => e.innerText.trim().replace(/\\s+/g, ' ')).filter(t => t && t.length < 400)`);
  const unique = [...new Set(errs as string[])].slice(0, 8);
  return unique.length ? unique : ["the page didn't move to the next step"];
}

/**
 * Click Submit on the Review step once and classify what the page shows. Never clicks twice:
 * anything unclear is "unknown" and goes to the owner (no double applications).
 */
export async function submitWorkday(page: Page, screenshotPath: string): Promise<SubmitOutcome> {
  if (!(await isReview(page))) return { kind: "invalid", errors: ["not on the Review step"] };
  await page.locator(`${A("pageFooterNextButton")}:enabled`).first().waitFor({ timeout: 30_000 });
  await page.locator(A("pageFooterNextButton")).first().click();
  let outcome: SubmitOutcome = { kind: "unknown", detail: "no confirmation within 45s" };
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(750);
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const done = text.match(/(application (has been |was )?submitted|thank you for (applying|your application|your interest)|congratulations[^.]{0,80}|successfully submitted|we('ve| have) received your application)/i);
    if (done) {
      outcome = { kind: "submitted", evidence: done[0].slice(0, 120) };
      break;
    }
    if (await page.locator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"]').first().isVisible().catch(() => false)) {
      outcome = { kind: "captcha" };
      break;
    }
    const errs = (await page.evaluate(`[...document.querySelectorAll('[data-automation-id*="rror"], [role="alert"]')].filter(e => e.offsetParent).map(e => e.innerText.trim()).filter(Boolean)`)) as string[];
    if (errs.length && (await isReview(page))) {
      outcome = { kind: "invalid", errors: [...new Set(errs)].slice(0, 5) };
      break;
    }
  }
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  return outcome;
}

/** Workday's "Something went wrong – please refresh" page (e.g. reopening an application that has a saved draft). */
export async function recoverErrorPage(page: Page): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const broken = await page.getByText(/something went wrong/i).first().isVisible().catch(() => false);
    if (!broken) return;
    await page.reload({ waitUntil: "networkidle" }).catch(() => undefined);
    await page.waitForTimeout(3000);
  }
}

export async function currentStep(page: Page): Promise<string> {
  return (await page.locator(A("progressBarActiveStep")).first().innerText().catch(() => "")).split("\n").pop()?.trim() ?? "";
}

export const isReview = async (page: Page) => /review/i.test(await currentStep(page));
