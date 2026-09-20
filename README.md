# Faculty Search Desk

A private workspace for a faculty job search, organized as schools → departments → individual openings. Built with React, Vinext, Cloudflare Workers/D1, and optional browser WebMCP tools for a Codex researcher.

## What it does

- Keeps a personal school shortlist separate from a wider discovery pool.
- Tracks CS, CSE, EECS, ECE, and other departments independently.
- Saves a pasted HTTPS source as an immediate draft. When available, it extracts page titles and structured JobPosting data. Drafts remain unverified until research checks them.
- Separates full-consideration/review dates from final closing dates.
- Tracks application progress, required documents, references, notes, and source verification.
- Stages new discoveries for human review; repeat research preserves personal notes and workflow.
- Stores data in D1, provides JSON export, and rejects stale edits with optimistic concurrency.
- Exposes seven WebMCP tools to read records, save links, stage research, update school sources, complete intake, record coverage, and change application workflow.

## Run locally

Requires Node.js 22.13+ and npm.

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_small_hex.sql
npm run dev -- --hostname 127.0.0.1
```

Open the printed URL, then choose **Sign in with ChatGPT**. On loopback development only, the starter supplies a mock user. It is never a production login. Local data is under the ignored `.wrangler/state` directory. The first successful authenticated API request claims ownership of the database.

```sh
npx tsc --noEmit
npm run build
```

After schema changes, run `npm run db:generate` and apply only the new migration. Never replay or rewrite an applied migration.

## Host your own private copy

This project is designed for OpenAI Sites: ask Codex with Sites available to register and deploy this checkout with its own project ID, the `DB` D1 binding, and owner-only access. Do not reuse another person's project ID, database, cookies, or source credentials. The database is single-owner by design. Every API call requires a platform-authenticated user and checks it against the database owner.

The hosted platform must strip untrusted incoming identity headers and inject verified `oai-authenticated-user-id` and `oai-authenticated-user-email`. Do not expose this Worker directly to the public internet behind an untrusted header passthrough. Deploying outside Sites requires implementing a real authentication adapter first.

## Daily research through a subscription

The website itself does not call a paid AI API and does not consume a subscription as an embedded API. A separately scheduled Codex task does the research using its available web/browser tools and writes results back through the site's WebMCP tools. An MCP-capable browser exposes those tools only within the signed-in page.

Create a daily task in Codex after deploying your own site. Use `docs/research-prompt.md`, replacing the site URL. Local scheduled tasks need the computer awake and Codex running, plus an authenticated site session. Scheduling is not created merely by cloning the repository. If the session or source is unavailable, the task must report the blocker, not claim a completed search.

Pasted links get a draft immediately; semantic verification and discovery happen on the next scheduled pass. Sources requiring JavaScript, blocked fetches, PDFs, and unclear requirements remain explicitly unverified until the researcher can inspect them. Research suggestions never submit applications or contact anyone.

## Data and source policy

The ranking scope is a sourced union: include US schools in the top 50 of any selected credible CS ranking and include ties. The initial directory is a September 20, 2026 snapshot, not a permanently current or exhaustive ranking. Some U.S. News membership is reported by CS Open Rankings with the original edition unspecified; those records say so. Research area and time-window choices change rankings.

Hiring hubs are not proof of openings. Use individual official postings, preserve distinct application IDs, mark closed or stale ads, and keep unknown fields empty. Official source URLs and verification dates accompany findings. Code is MIT licensed; linked rankings and source websites retain their own terms. This repository does not redistribute CSRankings code or publication datasets.

## Layout

- `app/page.tsx`: user interface and WebMCP registration
- `app/api/desk/route.ts`: authenticated validated actions
- `lib/store.ts`: prepared-statement D1 persistence
- `lib/intake.ts`: bounded academic-source fetch and draft extraction
- `lib/types.ts`, `lib/seed.ts`: data model and initial records
- `db/schema.ts`, `drizzle/`: schema and migrations

Never commit personal exports, `.env` files, `.wrangler` databases, login cookies, or credentials. The public distribution includes sample public-source data only.
