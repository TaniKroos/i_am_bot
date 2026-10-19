# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Headless workers under `data/` (resume builds) also load this file: ignore it and follow the `CLAUDE.md` in your working folder.**

## What this is

A personal Grok-Bot-style agent platform for one owner, running on their Mac mini. The first agent, `jobs`, discovers roles, picks or tailors a truthful resume, fills applications in a bot-owned Chrome, and auto-submits when every gate passes. There are no per-application approvals: failed gates go to the owner on Telegram as "needs you". `readme.md` has the full pipeline, setup and CLI reference.

## Commands

```bash
npm run typecheck                 # tsc --noEmit; the only static check (no linter, no test suite)
npm run bot -- <command> [args]   # every operation goes through src/cli.ts
npm run bot -- apply <job> --dry-run   # end-to-end check on one job without submitting
npm run bot -- fill <job>         # fill one Greenhouse form + screenshot, never submits
npm run bot -- plan -v            # answer-engine dry run over Greenhouse matches
npm run bot -- sweep              # one-shot find-only run: poll all boards, score, digest + referral leads, exit
npm run bot -- schedule [9 18]    # sweep daily under launchd (com.grokbot.sweep in ~/Library/LaunchAgents); unschedule
npm run bot -- run [--dry-run]    # long-running loop + Telegram commands (single instance via data/bot.pid; holds caffeinate)
npm run bot -- start | stop | status   # same loop under launchd (com.grokbot.agent, plist in data/, never at login); logs in data/logs/bot.log
docker build -t grokbot-latex:1 tools/latex   # required once for resume builds
```

There are no unit tests. Verify changes with `typecheck` plus a dry run (`fill`, `plan`, `apply --dry-run`), and **look at the screenshot**. A report can say ✅ while the page shows something else; the filler reads values back for exactly this reason.

Use **Node 24** (`.nvmrc`; `nvm use`). `better-sqlite3` is a native add-on built for one Node version: if Node changes, run `npm rebuild better-sqlite3`.

npm 11 blocks install scripts: after adding native deps, run `npm install-scripts approve <pkg>` and `npm rebuild <pkg>`.

## Architecture (the parts that span files)

- **Runtime model** (`src/core`): an `Agent` is a plugin with its own `migrations`, `automations` (intervals) and task `handlers`. `Runtime` schedules automations and pumps the SQLite task queue with per-kind `concurrency`. Tasks are durable (crash recovery, `dedupeKey`, retries with backoff). Throw `Deferred` from a handler to retry later *without* spending an attempt (pause, caps, Claude usage limits).
- **Migrations** are append-only entries like `jobs:00N` and are never renamed. Core tables are `events`, `tasks` and `kv`; agent settings live in `kv` (`agent='jobs'`, `setting:*`).
- **Jobs data flow:** `companies` (directory, tier 1 = poll every 3 min) → `poll_board` → `jobs` (`baseline` on first poll / `new`) → `score_job` → `matched` → `prepare_application` → `submit_application`. Per-application state is in `applications`. The `feed-pipeline` automation also enqueues already-matched jobs, so a new careers-system adapter picks up the backlog automatically.
- **Sources** (`agents/jobs/sources`): one `BoardFetcher` per careers system. Large boards (SmartRecruiters, Workday, Oracle) page newest-first, stop at the first known posting, and leave `description` empty. `score_job` screens on title/location first and only then calls `fetchDetails`. Board tokens are composite for Workday (`host|tenant|site`) and Oracle (`host|siteNumber`). Workday maintenance throws `TemporarilyUnavailable`, which must not deactivate a board.
- **Submittable careers systems** are listed in `pipeline.ts` `SUBMITTABLE` (Greenhouse and Workday). A new system needs a form reader (→ `FormField[]`), a filler and a submitter under `apply/`, then an entry in that set.
- **Workday** (`apply/workday.ts`, `apply/workday-run.ts`): questions are only visible after sign-in, so there is no planning step; `applyWorkday` signs in (Google → Keychain password `grokbot-site`/<host> → create account with a generated password), then `fillStep` reads each step's `formField-*` widgets, answers them with the same answer engine (+ composer for that step's asks), reads values back, refills anything Workday blanked, and stops at Review (dry run) or clicks Submit once. Drafts persist on Workday: uploads replace earlier attachments, and "Continue Application" / error pages are handled in `openApplication`.
- **Answers** (`apply/answers.ts`): order matters. Owner answer bank → EEO → files → identity → work authorisation *before* location (its wording mentions "country") → experience/compensation → education → consent → `ask` if required, else `skip`. Option matching is strongest-first across all candidates (exact → starts with → whole word), because "Male" ⊂ "Female".
- **Resumes**: tier 0 = base or an approved variant chosen by `resume-gap.ts` (deterministic). Tier 1 is Sonnet, used when gap ≥ `TAILOR_GAP` and score ≥ `TAILOR_MIN_SCORE`. Tier 2 is Opus, used when score ≥ `OPUS_MIN_SCORE`. Any failure or usage limit falls back to tier 0. `tailor.ts` builds a per-folder workspace (JD, base `.tex`, facts, the synced `resume-tailoring` skill, a generated `CLAUDE.md` of overrides) and runs `core/workers/claude-code.ts`.
- **Claude Code worker**: `claude -p` on the owner's subscription (it strips `ANTHROPIC_API_KEY`) with `--strict-mcp-config` and `--tools` derived from the allowlist, which cuts per-turn context about 5×. Don't add MCP servers or broad tools to it. LaTeX tools are wrappers in `tools/latex/bin` that run the sandboxed container on `$PWD`.
- **Applied ledger** (`applied.ts`, table `applied`): bot submissions + Gmail confirmations parsed into company / title / requisition id. `alreadyApplied()` runs in both pipeline steps; `appliedAtCompany()` (distinct) feeds the per-company cap. Gmail calls share a per-minute quota with security-code reading: keep syncs paced and incremental.
- **Composer** (`apply/compose.ts`): required questions the rules return as `ask` (except EEO) go to one Sonnet call grounded in `profile/experience.md` + resume + profile. Text answers are checked with the truth-check helpers (numbers exact; unclaimed tech only inside a negating sentence). Results are stored in `applications.composed` and reused at submit via `planApplication(..., composed.values)`.
- **Referrals** (`referrals.ts`): the digest's top companies get people found through Brave Search (`site:linkedin.com/in`, cached in `people` for 14 days), a template note filled from `profile.yaml` facts, and Sent / Followed up buttons stored in `outreach`. The bot never logs in to LinkedIn or messages anyone. `sweep` handles button taps queued since the last run (`pollTelegram({ once })`) and restricts the runtime to `poll_board` + `score_job`, so queued applications never run.
- **Truth check** (`truthcheck.ts`) gates every tailored resume: numbers must exactly match the owner's sources (including `+`/`%`), JD-only technology terms are "borrowed", and `do_not_list_terms` are forbidden. It shares tokenisation with `resume-gap.ts`; change both together.

## Invariants

- Never let the bot invent facts. Everything comes from `profile/resume.tex`, `profile/profile.yaml` (`facts`, `verified_claims`, `do_not_claim`, `do_not_list_terms`, `approved_terms`) and `profile/answers.yaml`. New owner answers go into those files, not into code.
- Never retry automatically after Submit is clicked: `unknown` outcomes go to the owner, to avoid double applications.
- No CAPTCHA solving or bot-detection evasion; challenges become Telegram alerts.
- `profile/`, `data/` and `.env` are gitignored and hold personal data. Gmail's refresh token is in the macOS Keychain (`grokbot-gmail`).

## Gotchas

- `tsx` adds a `__name` helper to functions, which breaks `page.evaluate(fn)`. Pass in-page code as a **string** (see `requiredEmpty` in `apply/greenhouse-fill.ts`).
- The bot browser launches with `ignoreDefaultArgs: ["--use-mock-keychain"]` so it can read the owner's Google login saved by plain Chrome (`bot browser-login`). It closes itself after 2 idle minutes to free the profile. Never drive the owner's default Chrome profile.
- Greenhouse renders short multi-selects ("I Agree") as a `<fieldset>` of checkboxes whose input ids are `<key>_<optionValue>`, not as a combobox.
- Greenhouse forms: open the embed URL `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`, wait for `networkidle` before uploading (otherwise its uploader throws `uploadFile` of undefined), and upload through the Attach button's file chooser.
- ESM with `NodeNext`: relative imports need `.js` extensions. `.env` is loaded via `process.loadEnvFile` in `core/config.ts`.
- The Python on this Mac lacks CA certificates. Use Node `fetch` for HTTPS probes; never disable verification.
