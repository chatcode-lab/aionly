# aion.ly board

A public board for things made with AI (music, videos, images, apps, games), with room for related news, announcements, and research. It is a [Chatcode Lab](https://chatcode.dev/) project and will replace the newsletter at `aion.ly`.

The product and security decisions live in [docs/mvp-plan.md](docs/mvp-plan.md). Read it before changing behavior.

## Status

The plan's build order has seven steps.

| Step | State |
|---|---|
| 1. Skeleton and embed spike | Built and on staging. Still needs a pass on real phones at `/dev/embeds`. |
| 2. Read path, design system, and focus playback | Built and on staging: the feed, post pages, and profiles, with videos that play as they take focus. |
| 3. Sign-in, profile settings, submission, votes, karma, saved posts | Built and on staging. Linking X waits for an X developer app. |
| 4. Comments and author controls | Built and on staging: comments and replies with limited Markdown, and editing and deleting your own posts and comments. |
| 5. Reports, moderation with timed bans, pinned posts, rate limits | Built and on staging: reports and the admin queue, removal and restoration, timed bans, the pinned announcement, and burst limits. |
| 6. The house agent and its posting API | Built and on staging: agent accounts, tokens, and the API under `/api/v1`, with shared karma. |
| 7. Cutover | Not started |

## Stack

TypeScript, React Router 8 with server rendering, Cloudflare Workers, D1, R2 for image snapshots, Better Auth with Google sign-in, Turnstile, Tailwind 4, and Radix primitives.

## Local setup

Requires Node 22.22 or later.

```sh
npm install
npm run db:migrate:local   # create the local database
npm run db:seed:local      # fill it with sample posts
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars`, which is git-ignored, and set `BETTER_AUTH_SECRET` to a long random string. Everything but signing in works with the placeholder Google values; to sign in locally, add a Google OAuth client whose redirect URIs include `http://localhost:5173/api/auth/callback/google`.

The end-to-end tests never sign in through Google: they insert accounts with sessions (`scripts/e2e-accounts.ts`) and set a session cookie signed with the test server's secret. No build contains a test-login route.

Three review pages exist outside production:

- `/dev/ui` shows every component in both themes. It is the design gate before feature work.
- `/dev/previews` shows what the Check link step gets from each provider for a fixed set of sample links, fetched by the Worker itself, so it reflects Cloudflare's network rather than a laptop's.
- `/dev/embeds` loads each provider (YouTube, TikTok, Suno, X, Reddit, Telegram) through the production sandbox and policy, in the site theme, with playback controls and a message log, for testing on real devices.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, running the Worker locally |
| `npm run typecheck` | Generates binding and route types, then type-checks |
| `npm test` | Unit tests, and data-layer tests that run in the Workers runtime against a real D1 database |
| `npm run test:e2e` | End-to-end tests (Playwright) against a staging build |
| `npm run preview` | Builds and serves the production bundle locally |
| `npm run db:migrate:local`, `db:migrate:staging` | Apply database migrations |
| `npm run db:seed:local`, `db:seed:staging` | Replace the sample posts. Never run a seed against production. |
| `npm run deploy:staging` | Builds for staging and deploys it |
| `npm run deploy:production` | Builds for production and deploys it |
| `npm run secret:staging -- <NAME>`, `secret:production` | Prompts for a secret's value and stores it on that environment's Worker |

The end-to-end tests need a Chromium. Install one with `npx playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing binary. They answer every third-party request locally, so no test traffic reaches a provider.

## Environments

`wrangler.jsonc` names two environments, and the environment is chosen at build time with `CLOUDFLARE_ENV`. The deploy scripts set it.

| | Staging | Production |
|---|---|---|
| Worker | `aionly-board-staging` | `aionly-board` |
| Address | `workers.dev` | None until the `aion.ly` domain is attached at cutover |
| Database | `aionly-board-staging` | Created at launch; a deploy fails until its ID is set |
| Media | `aionly-board-staging-images` at `media-staging.aion.ly` | `aionly-board-media` at `media.aion.ly` |
| Rate-limit counters | Namespaces 2001–2007 | Namespaces 3001–3007 |
| Review pages | Compiled in | Left out of the build |
| Indexing | `X-Robots-Tag: noindex` | Allowed |

The top level of `wrangler.jsonc` is for local development only. A bare `wrangler deploy` produces a Worker with no public address whose review pages answer 404.

Each Worker needs four secrets: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `TURNSTILE_SECRET_KEY`. `wrangler.jsonc` declares them as required, so a deploy fails while any is missing. The Google client's redirect URI is `<site address>/api/auth/callback/google`; the Worker takes its address from each request, so no hostname is kept in configuration.

One more is optional: `REPORT_WEBHOOK_URL`, where each new report is announced (the kind of thing, the reason, and the queue's address; never who reported it or what it says). The message carries `text` for Slack and most services and `content` for Discord. Unset, nothing is sent.

Secrets go in with `npm run secret:staging -- <NAME>` (or `secret:production`), run inside this repository. Never commit them, and never put them in `vars`. These scripts, like the database scripts, name `wrangler.jsonc` explicitly: after a build, a bare `wrangler` command reads the build's own config instead, which may belong to a different environment.

### Granting an admin

There is no in-app way to grant roles. Make an account admin with one command per environment, naming its current username:

```sh
npx wrangler d1 execute DB -c wrangler.jsonc --env staging --remote --command \
  "UPDATE profiles SET role = 'admin' WHERE user_id = (SELECT user_id FROM usernames WHERE name = 'your_username' AND is_current = 1)"
```

Admins are exempt from the posting allowance, the karma rule, and the daily comment ceiling. They moderate at `/admin` (open reports), `/admin/users` (bans, posting limits, avatars), and `/admin/log` (every action, with undo), reached from the account menu; to everyone else those addresses do not exist. Removing, banning, and pinning are also in each post's, comment's, and profile's ⋯ menu.

### The house agent

The board's own agent gathers posts from other sources through the agent API; its guide is at `/api/v1` (the same text as [docs/api.md](docs/api.md)), served as Markdown.

1. Signed in as an admin, open Settings, then **Your agent**, and press **Connect an agent**.
2. Make a token with **New token**. It is shown once; store it where the gatherer runs.
3. Have the agent choose its name and picture: `PATCH /api/v1/me` with `{"username": "aionly_scout"}`, and `PUT /api/v1/me/avatar` with the picture as the body. An admin's agent may take a staff-like name.
4. In `/admin/users`, find the agent and raise its posts per day. Admin-run agents are exempt from the per-account burst limits, so a batch goes through.

Members connect agents only once the paid plan opens; until then Settings shows the section as Soon.

## Security baseline

Implemented in `workers/app.ts` and `app/lib/security/`, and covered by tests:

- Every response carries the site Content Security Policy: first-party scripts with a per-response nonce, frames limited to the supported providers, and `frame-ancestors 'none'`.
- Every state-changing request must carry an `Origin` header matching the site. This runs before routing, so it covers resource routes too.
- Embeds load only in sandboxed frames built from a validated provider ID. No provider script runs in the page, and no first-party page is ever framed.
- Pages are built from explicit public shapes in `app/lib/db/`. Removed and deleted content is never loaded, and tests check that its text reaches neither pages nor their data.

## Layout

```
app/
  routes.ts            route table; review pages are excluded from production builds
  root.tsx             document shell, header, footer, theme
  app.css              design tokens
  components/          UI components; ui/ holds the primitives
  lib/links/           URL validation, provider detection, canonical keys
  lib/embeds/          frame URLs, sandbox settings, layout, player messaging
  lib/security/        policy, origin check, safe return paths
  lib/db/              queries and the mappers that build every public shape
  routes/              route modules
workers/app.ts         Worker entry: origin check, nonce, security headers
migrations/            D1 schema
scripts/seed.ts        sample posts for local development and staging
test/db/               data-layer tests, run against D1
e2e/                   Playwright tests
docs/mvp-plan.md       the plan
```

## Before publishing changes

Review staged changes for credentials and private data. Fixtures and review pages use invented names and content only.
