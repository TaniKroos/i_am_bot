# grokBot

A personal agent platform modeled on xAI's Grok Bot. It runs on your own Mac, takes commands over Telegram, and hands real work to worker agents, including headless Claude Code.

The first agent is **Jobs**. It finds fresh roles across company career sites, picks or tailors a truthful resume, fills the application, and submits it on its own. Anything it can't do safely goes to you on Telegram.

```
 Telegram (owner only) ──► runtime (agents · automations · durable task queue, SQLite)
                                │
                                └─ jobs agent
                                   discover ─► score ─► plan answers ─► resume (tier 0/1/2)
                                   ─► truth check ─► fill in Chrome ─► verify ─► submit ─► proof
                                        │                                   │
                                Claude Code worker                  bot-owned Chrome profile
                                (headless, your login)              (your home IP, persistent)
                                LaTeX in a sandboxed container
```

## What it does today

| Stage | Status |
|---|---|
| **Discovery:** 550+ company boards on Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday and Oracle Recruiting Cloud. Hot companies are polled every 3 min, the rest every 30 min. | ✅ |
| **Self-growing directory:** add any job or careers URL and the board is detected, including Oracle sites on company domains. | ✅ |
| **Scoring** against your profile: title, location (India / remote-India), years required, skills | ✅ |
| **Answer engine:** answers form questions from your answer bank → profile → rules. Unknown required questions are asked once, then remembered. | ✅ |
| **Resumes:** ready-made variants, tailoring only when worth it, and a deterministic truth check | ✅ |
| **Fill and submit: Greenhouse** | ✅ |
| Fill and submit: Lever, Ashby, SmartRecruiters, Workable, Oracle, Workday | ⏳ discovery only |
| Gmail read-only sign-in | ✅ |
| **Greenhouse security codes** read from Gmail and entered automatically | ✅ |
| **Never apply twice**: ledger of bot submissions + Gmail confirmations (job id, requisition id, same-role fingerprint) | ✅ |
| Updating status from rejection / interview emails | ⏳ |
| Live browser view for CAPTCHAs, web dashboard | ⏳ |

## How a job becomes an application

1. **Discover:** new postings are stored. The first poll of a board only counts the last 21 days as new.
2. **Score:** titles, location and experience are screened first. Only roles that suit the owner's level pass: nothing asking more than 2 years, no senior / level-3+ titles, and no titles built around a stack you don't use ("Java Developer", "Backend Engineer (Go)"). Large boards only fetch full descriptions for jobs that pass. Matches are jobs scoring ≥ 60.
3. **Plan:** read the application's questions (Greenhouse publishes them) and answer each one by rule (profile, answer bank, consents, EEO). Questions about your experience ("Describe a distributed system you built", "Have you used Kafka?") go to the **composer**: one Sonnet call writes them from `profile/experience.md`, your resume and profile only, and every answer is truth-checked (numbers must exist in your files; a technology you never claimed may only appear in a sentence saying you haven't used it). Anything still unanswered goes to Telegram and into `profile/questions-pending.yaml`.
4. **Resume:** cheapest option first.
   - **Tier 0, no Claude:** the base resume or an approved role variant (`ai-llm`, `backend`, `fullstack`, `platform`), whichever has the smallest *gap*.
   - **Tier 1, Sonnet:** used when the best tier-0 resume's gap is ≥ 20% and the job scores ≥ 80.
   - **Tier 2, Opus:** used for jobs scoring ≥ 95, or when Sonnet's resume fails the truth check.
   - If tailoring fails or Claude's usage limit is hit, the job falls back to tier 0. It never waits and never ships an unchecked resume.
5. **Truth check:** every tailored resume is compared with your base resume and fact bank. A number that isn't in your sources, a technology borrowed from the job description, or a term on your do-not-list blocks the resume.
6. **Fill:** the bot's own Chrome fills the form and uploads the PDF (confirmed by S3's `201`). Every dropdown is read back from the page, and a final sweep catches required fields the API didn't list.
7. **Submit:** happens only when every gate passes. If Greenhouse asks for the 8-character security code it emails, the bot reads it from Gmail (read-only) and enters it. The result is classified as *confirmed*, *CAPTCHA*, *form error* or *unknown*. The bot never retries after clicking Submit, so it can't apply twice.
8. **Proof:** `filled.png`, `after-submit.png`, `answers.json` and the resume used are kept in `data/applications/<job>/`, and a ✅ FYI goes to Telegram.

### The "gap" measure

The gap is how much a resume under-sells you for a given job description, measured without any model call.

- **Keywords:** technologies in the job description that you can truthfully claim. These come from your base resume's skills section and your profile; your do-not-list is excluded.
- **Scoring:** each keyword scores 2 if it's prominent (summary, first two experience bullets, first skills row), 1 if it appears elsewhere, and 0 if it's missing.
- **Result:** `gap = 1 − score / (2 × keywords)`.

## Rules the bot never breaks

- **No invented facts.** Resumes and answers only use `profile/resume.tex`, `profile/profile.yaml`, `profile/experience.md` and `profile/answers.yaml`. Experience is never rounded up. Personal projects are never presented as production work.
- **No per-application approvals, but strict gates.** Anything that fails a gate goes to Telegram as 🔔 *needs you*; it is never submitted.
- **No CAPTCHA solving or bot-detection evasion.** Challenges go to you.
- **EEO / demographic questions are declined** unless the form makes one mandatory and your profile has an answer.
- **Workday accounts:** "Continue with Google" where a site offers it; otherwise the bot signs in with a password it created and keeps in your macOS Keychain (service `grokbot-site`, one entry per Workday site), or creates the account with your email and a new generated password. If you already have an account there without Google sign-in, the job comes to you on Telegram. The bot never reads Chrome's or Google's saved passwords.
- **Never twice:** a job is skipped if its job id, its requisition id (from your confirmation emails) or the same role at the same company is already in the applied ledger, including applications you made yourself (`npm run bot -- applied --sync`).
- **Caps:** 60 applications a day, and at most 2 per company per 30 days, counting applications you made yourself. Use `/pause` to stop everything instantly.

## Setup

**Requirements:** macOS (this setup runs on a Mac mini), Node 24 (see `.nvmrc`; after switching Node versions run `npm rebuild better-sqlite3`), Docker Desktop, Google Chrome, and Claude Code signed into your Claude account. The binary bundled with the VS Code extension is found automatically; otherwise set `CLAUDE_BIN`.

```bash
npm install
docker build -t grokbot-latex:1 tools/latex     # sandboxed TeX Live 2023 (pdflatex, pdfinfo, pdftoppm)
```

### 1. Your private files (gitignored, never committed)

| File | What |
|---|---|
| `profile/resume.tex` | Your base resume in LaTeX. It is also the template for every tailored resume. |
| `profile/Tanish_Resume.pdf` | The compiled base resume, used for tier 0. |
| `profile/profile.yaml` | Identity, facts (experience, notice, CTC, work authorisation), verified claims, the do-not-claim / do-not-list terms, approved wording, and targeting (titles, skills). |
| `profile/answers.yaml` | Your answers to application questions, as `match: <regex>` plus `answer:`. Supports a `{company}` placeholder. |
| `profile/experience.md` | Your work knowledge base in plain Markdown: what you built, how, with which numbers, and a "Not done" list. The composer writes free-text answers from it. The more detail, the fewer questions reach you. |
| `profile/google-oauth-client.json` | Google OAuth "Desktop app" client (Gmail read-only). |
| `.env` | `TELEGRAM_BOT_TOKEN=…` |

### 2. Telegram

Create a bot with @BotFather, put its token in `.env`, then pair it so only you can control it:

```bash
npm run bot -- pair        # prints a 6-digit code; send "/start <code>" to your bot within 10 minutes
```

### 3. Gmail (read-only)

Create a Google Cloud project, enable the Gmail API, add the `gmail.readonly` scope and yourself as a test user, then create a Desktop OAuth client and save its JSON as `profile/google-oauth-client.json`.

```bash
npm run bot -- gmail-login   # opens Google's consent page; the refresh token is stored in the macOS Keychain
npm run bot -- gmail-check
```

While the Google app is in "Testing", access expires after 7 days. Publish it as "In production" to stop that (see `later.md`).

### Browser sign-in (Google, job sites)

The bot fills forms in its own Chrome profile (`data/browser-profile`), never your everyday one: Chrome refuses automation on its default profile. Sign in there once with plain Chrome:

```bash
npm run bot -- browser-login            # opens Google sign-in; add URLs to open job sites too
```

The bot pauses and waits for its browser to close. Sign in to Google (turn on Chrome sync if you want your saved passwords there) and to any job sites, then quit Chrome (⌘Q); the bot resumes. Cookies are encrypted with the real macOS keychain, so the session carries over to the bot, and "Continue with Google" works where sites offer it.

### 4. Companies and resume variants

```bash
npm run bot -- seed                      # resolve the starter company list
npm run bot -- variants build            # build the 4 role variants (Sonnet, one-time)
npm run bot -- variants approve ai-llm backend fullstack platform   # after reviewing the PDFs
```

## Running it

### Find jobs + referral leads, twice a day (recommended)

```bash
npm run bot -- sweep              # poll every board once, score, send the Telegram digest, exit
npm run bot -- schedule           # run sweep every day at 9:00 and 18:00 (or: schedule 8 13 19)
npm run bot -- unschedule         # stop the schedule
```

A sweep needs no Claude usage and nothing stays running in between. The digest lists every new match. For the best 8 companies it also sends a message with people who could refer you, a connection note to paste (written only from your `profile.yaml` facts, at most 200 characters), and LinkedIn search buttons that open in your own browser. The bot never logs in to LinkedIn or sends anything for you. Tap **✅ Sent** after messaging someone. The next sweep records it, and five days later the digest asks you to follow up.

People come from Brave Search (`site:linkedin.com/in`, the company and your college). Add `BRAVE_API_KEY=…` to `.env` (free plan at api-dashboard.search.brave.com, about 2,000 queries a month). Each company is searched at most once every 14 days. Without a key you still get the note and the LinkedIn search buttons. To change the note, set `referral.note` in `profile/profile.yaml`. Placeholders: `{first} {role} {employer} {years} {title} {company}`.

To see the last 7 days of matches in your browser, run `npm run bot -- ui` (http://localhost:4310, this Mac only). Each job has its Apply link, **Mark applied**, and under Referrals the people found, the note with a Copy button, and **Mark sent** for each person. Jobs you mark applied are left out of future digests. Older jobs drop off the page but stay in the database, so they are never reported as new again.

### Continuous mode (apply mode)

```bash
npm run bot -- run              # poll, score, prepare and submit continuously; listens on Telegram
npm run bot -- run --dry-run    # same, but fills and screenshots without ever clicking Submit
```

The bot only runs while this process does, and it keeps the Mac awake while it runs (it holds its own `caffeinate`; the display may still turn off). Only one copy runs at a time.

To run it in the background instead (no terminal needed, restarts itself after a crash, **never starts at login**):

```bash
npm run bot -- start     # run in the background until you stop it, log out or restart the Mac
npm run bot -- stop      # stop everything: no polling, no Claude usage, the Mac sleeps normally
npm run bot -- status    # running or not, plus the last log lines (data/logs/bot.log)
```

To keep it running but stop Claude usage and submissions, send `/pause` on Telegram (`/resume` to continue).

### Telegram commands

| Command | |
|---|---|
| `/status` | Mode, applications today vs. cap, counts by status |
| `/queue` | Applications waiting on you, and why |
| `/pause` · `/resume` | Stop / restart all preparing and submitting |
| `/dryrun on` · `/dryrun off` | Fill without submitting / go live |
| `/cap <n>` | Change the daily application cap |

### CLI reference

| Command | |
|---|---|
| `seed` | Resolve the starter list (`src/agents/jobs/seed.ts`) into the company directory |
| `add-company <names…> [--hot]` | Find a company's board by name (Greenhouse / Lever / Ashby / SmartRecruiters / Workable) |
| `add-url <url…> [--name X] [--hot]` | Add a board from any job or careers link (also Workday and Oracle) |
| `poll` | Poll every board once and score new postings |
| `ui [port]` | Local page of the last 7 days of matches: mark applied, referral people, copy the note, mark messaged |
| `sweep` · `schedule [hours…]` · `unschedule` | Poll, score and send the digest with referral leads; run it daily at fixed hours |
| `matches [n]` · `rejections` · `rescore` | Inspect matches, see why jobs were skipped, re-run scoring after editing the profile |
| `plan [-v]` | Dry-run the answer engine over Greenhouse matches; refreshes `questions-pending.yaml` |
| `fill <job>` | Fill one Greenhouse application and screenshot it, never submitting |
| `apply <job> [--dry-run]` | Run the whole pipeline for one job now |
| `tailor <job> [--model opus\|sonnet]` | Build one tailored resume (writes `notes.md`, `truthcheck.json`) |
| `variants list\|build\|approve` | Manage tier-0 resume variants |
| `pair` · `gmail-login` · `gmail-check` | Connect Telegram and Gmail |
| `start` · `stop` · `restart` · `status` | Run in the background under launchd (crash restart, never at login) |

`<job>` is a job id (e.g. `greenhouse:mongodb:8221290`) or text matching its title and company.

## Project layout

```
src/
  cli.ts                      commands
  core/
    runtime.ts                runs agents: automations + task handlers with per-kind concurrency
    queue.ts                  durable SQLite task queue (retries, deferral, crash recovery)
    db.ts · config.ts · agent.ts
    workers/claude-code.ts    headless `claude -p` on the owner's login; tool allowlist, no MCP servers
    channels/telegram.ts      owner-only bot (pairing code), alerts, files, commands
    google/auth.ts            Gmail read-only OAuth (PKCE, loopback), token in the Keychain
    service.ts                background start / stop under launchd (never at login)
  agents/jobs/
    index.ts                  agent: migrations, polling automations, handlers
    sources/                  greenhouse · lever · ashby · smartrecruiters · workable · workday · oracle
    resolve.ts                job/careers URL → board
    scorer.ts                 title / location / experience / skills
    pipeline.ts               prepare_application · submit_application · settings and caps
    tailor.ts                 per-job and per-variant resume builds (Claude Code + resume-tailoring skill)
    truthcheck.ts · resume-gap.ts · variants.ts
    apply/                    answers · compose (free-text from experience.md) · plan · greenhouse reader, filler, submitter · browser
tools/latex/                  Dockerfile + pdflatex/pdfinfo/pdftoppm wrappers
data/                         (gitignored) grokbot.db, browser profile, applications, variants, logs
profile/                      (gitignored) your private profile, resume and answers
```

## Security notes

- **LaTeX** runs in Docker with no network, a read-only root filesystem, all capabilities dropped and 1 GB of memory, and only the current application folder mounted.
- **Claude Code workers** run on your own login. Each sees one folder, gets an explicit tool allowlist, and loads no MCP servers. `ANTHROPIC_API_KEY` is removed from their environment.
- **Telegram** ignores everyone except the paired owner.
- **Gmail** access is `gmail.readonly` only; the sign-in refuses any wider grant. Revoke it at myaccount.google.com → Security → Third-party connections.
- **Chrome:** the bot uses its own Chrome profile in `data/browser-profile` and never touches your everyday Chrome profile.
- **Personal data** (`profile/`, `data/`, `.env`) is gitignored.

## Known gaps

- Workday was in maintenance while its adapter was written. Newest-first ordering is confirmed on one tenant (Accenture) and still needs checking on more. 29 guessed Workday site addresses were deactivated automatically.
- Oracle's own careers site lists jobs but returns an empty list through the API.
- Workable rate-limits bursts. Requests are spaced 3 s apart and a rate-limited board is skipped until its next cycle.
- The truth check compares words and numbers, so it can't catch a true fact credited to the wrong project. Tailoring rules guard against that, but an occasional human look is still worthwhile.

## Roadmap

1. Gmail: read verification codes and links automatically; update status from confirmation, rejection and interview emails.
2. Fill-and-submit adapters for Ashby, Lever, SmartRecruiters, Workable and Oracle. Workday: fill Work Experience / Education sections too.
3. A live browser view so CAPTCHAs can be solved from your phone in seconds.
4. A private web dashboard over Tailscale with the application timeline, proof and stats.
6. More agents on the same runtime: X/news digests, inbox triage, general Claude Code tasks.
