# aion.ly board

A public board for substantially AI-generated music, videos, images, apps, games, and other creations. It is a [Chatcode Lab](https://chatcode.dev/) project and will replace the newsletter at `aion.ly`.

The product and security decisions live in [docs/mvp-plan.md](docs/mvp-plan.md). Read it before changing behavior.

## Status

The plan's build order has six steps. This repository is partway through the first two.

| Step | State |
|---|---|
| 1. Skeleton and embed spike | Built. Needs a staging deploy and a pass on real phones at `/dev/embeds`. |
| 2. Read path and design system | Design system and the `/dev/ui` gate are built. Feed, post, and profile pages are not. |
| 3. Sign-in, submission, votes, karma | Not started |
| 4. Comments and author controls | Not started |
| 5. Reports, moderation, rate limits | Not started |
| 6. Autoplay, playback ownership, cutover | Not started |

## Stack

TypeScript, React Router 8 with server rendering, Cloudflare Workers, Tailwind 4, and Radix primitives. D1, R2, Better Auth with Google sign-in, and Turnstile arrive with the steps that need them.

## Local setup

Requires Node 22.22 or later.

```sh
npm install
npm run dev
```

No secrets are needed yet. When they are, copy `.dev.vars.example` to `.dev.vars`; that file is git-ignored.

Two review pages exist outside production:

- `/dev/ui` shows every component in both themes. It is the design gate before feature work.
- `/dev/embeds` loads each provider through the production sandbox and policy, with playback controls and a message log, for testing on real devices.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, running the Worker locally |
| `npm run typecheck` | Generates binding and route types, then type-checks |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) against a staging build |
| `npm run preview` | Builds and serves the production bundle locally |
| `npm run deploy:staging` | Builds for staging and deploys it |
| `npm run deploy:production` | Builds for production and deploys it |

The end-to-end tests need a Chromium. Install one with `npx playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing binary. They answer every third-party request locally, so no test traffic reaches a provider.

## Environments

`wrangler.jsonc` names two environments, and the environment is chosen at build time with `CLOUDFLARE_ENV`. The deploy scripts set it.

| | Staging | Production |
|---|---|---|
| Worker | `aionly-board-staging` | `aionly-board` |
| Address | `workers.dev` | None until the `aion.ly` domain is attached at cutover |
| Review pages | Compiled in | Left out of the build |
| Indexing | `X-Robots-Tag: noindex` | Allowed |

The top level of `wrangler.jsonc` is for local development only. A bare `wrangler deploy` produces a Worker with no public address whose review pages answer 404.

Secrets go in with `wrangler secret put <NAME> --env <environment>`. Never commit them, and never put them in `vars`.

## Security baseline

Implemented in `workers/app.ts` and `app/lib/security/`, and covered by tests:

- Every response carries the site Content Security Policy: first-party scripts with a per-response nonce, frames limited to the supported providers, and `frame-ancestors 'none'`.
- Every state-changing request must carry an `Origin` header matching the site. This runs before routing, so it covers resource routes too.
- Embeds load only in sandboxed frames built from a validated provider ID. No provider script runs in the page.
- The embed shell at `/embed/shell/:provider/:id` is the one response with its own policy. It runs a provider script at an opaque origin and can be framed only by the site.

## Layout

```
app/
  routes.ts            route table; review pages are excluded from production builds
  root.tsx             document shell, header, footer, theme
  app.css              design tokens
  components/          UI components; ui/ holds the primitives
  lib/links/           URL validation, provider detection, canonical keys
  lib/embeds/          frame URLs, sandbox settings, player messaging, embed shell
  lib/security/        policy, origin check, safe return paths
  routes/              route modules
workers/app.ts         Worker entry: origin check, nonce, security headers
e2e/                   Playwright tests
docs/mvp-plan.md       the plan
```

## Before publishing changes

Review staged changes for credentials and private data. Fixtures and review pages use invented names and content only.
