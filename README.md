# Faculty Search Desk

A private workspace for a faculty job search, organized as schools → departments → individual openings. Built with React, Vinext, Cloudflare Workers/D1, and on-demand OpenAI API research and optional browser WebMCP tools.

## What it does

- Keeps a personal school shortlist separate from a wider discovery pool.
- Tracks CS, CSE, EECS, ECE, and other departments independently.
- Starts focused AI analysis when you add an HTTPS hiring link. It extracts individual openings, requirements and dates into the review inbox. Without an API key, the form clearly offers only Save for later.
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

## On-demand API research

Use **Add and analyze** to immediately analyze a hiring link and its application pages. **Search now** checks the shortlist or full discovery pool; saved links not already being analyzed are included first. Research runs only on user request; this project creates no daily schedule and needs no separate scheduler or Cloudflare account when hosted on Sites.

Click **API key** in the website, enter your own OpenAI key, and choose **Save key locally**. The password field clears after saving. The key is saved in localStorage for that browser profile and website origin; it is not synchronized across devices. **Forget key** removes it from this browser but does not revoke it at OpenAI or cancel work already started. LocalStorage is not an encrypted credential vault: browser-profile access or malicious same-origin scripts could expose it.

The browser sends the key only in a dedicated header to this website’s authenticated API routes. The server uses it for the current request and forwards it only to the fixed OpenAI API endpoint; redirects are disabled. Keys are never written to D1, research results, data exports, source code, or application logs. An optional operator-managed `OPENAI_API_KEY` hosting secret remains supported as a fallback; a browser key takes precedence. Never put keys into chat, source code, or `.openai/hosting.json`. `OPENAI_RESEARCH_MODEL` is optional and defaults to `gpt-5.6-terra`; use a Responses model supporting background mode, web search, and structured outputs. API billing is separate from a ChatGPT subscription. A missing key produces a setup message and never pretends a search ran. For local development, put these values in an ignored `.env` file (see `.env.example`).

The authenticated server starts a stored background Responses API request and saves its response ID in D1. The website polls while open and resumes checking after reload. The provider can continue after the tab closes; importing findings into D1 happens when the website next polls with a usable key. Missing or changed browser keys preserve the saved response. Restore the original key or a key for the same OpenAI project and retry status. If a result is no longer accessible, **Stop tracking** releases the job so you can start again; it does not cancel provider work. Link analysis runs independently of broader searches and is bounded to 25 tool calls; broader searches allow 120 tool calls and 16,000 output tokens, not a guaranteed complete census. Coverage gaps, failed sources, and unprocessed links stay visible.

Jobs are atomically claimed to prevent duplicate paid requests for repeated submissions. Link saves use an atomic insert-if-absent batch that cannot overwrite existing notes. Failed or incomplete analysis requires an explicit retry. Validated completed results and the run completion marker are imported in one guarded D1 batch. New openings enter the inbox, existing notes/workflow are preserved, and absent evidence does not erase known fields or close a position. Source and application URLs must belong to the school's domain, saved official sources, or supported hiring portals and appear in the provider's web evidence; this is a provenance check, not a guarantee that the model interpreted the source correctly. Review important requirements against the linked official posting.

The private research payload includes school names, department source URLs, known public posting identifiers, queued links, and role preferences. Personal notes and application workflow are not sent. Search and fetched content are untrusted data. Provider failures, refusals, and truncated outputs do not generate successful research records. An ambiguous start timeout is reported for manual review rather than automatically starting another paid request.

Optional subscription-based research remains possible through the browser WebMCP tools and `docs/research-prompt.md`; run it only when requested. Disable any older daily automation separately when switching to on-demand use.

## Data and source policy

The ranking scope is a sourced union: include US schools in the top 50 of any selected credible CS ranking and include ties. The initial directory is a September 20, 2026 snapshot, not a permanently current or exhaustive ranking. Some U.S. News membership is reported by CS Open Rankings with the original edition unspecified; those records say so. Research area and time-window choices change rankings.

Hiring hubs are not proof of openings. Use individual official postings, preserve distinct application IDs, mark closed or stale ads, and keep unknown fields empty. Official source URLs and verification dates accompany findings. Code is MIT licensed; linked rankings and source websites retain their own terms. This repository does not redistribute CSRankings code or publication datasets.

## Layout

- `app/page.tsx`: user interface and WebMCP registration
- `app/api/desk/route.ts`: authenticated validated actions
- `lib/store.ts`: prepared-statement D1 persistence
- `app/api/research/route.ts`, `lib/research.ts`: authenticated background API research
- `lib/research-result.ts`: validated source-linked findings
- `components/research-control.tsx`: search button, progress, and setup states
- `lib/add-source.ts`, `lib/intake.ts`: atomic link intake and immediate AI analysis; optional basic preview extraction
- `lib/types.ts`, `lib/seed.ts`: data model and initial records
- `db/schema.ts`, `drizzle/`: schema and migrations

Never commit personal exports, `.env` files, `.wrangler` databases, login cookies, or credentials. The public distribution includes sample public-source data only.

## Validation

Run `npx tsc --noEmit` and `node --test tests/*.test.mjs` (Node 24 recommended). The research tests use in-memory SQLite and a mocked provider; they never spend API credits.
