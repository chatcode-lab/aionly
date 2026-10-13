# aion.ly board MVP

## Summary and replacement

Create the board in the new public [chatcode-lab/aionly](https://github.com/chatcode-lab/aionly) repository as part of Chatcode Lab sessions. It will replace the newsletter at `aion.ly`, currently maintained in [tractorfm/aionly](https://github.com/tractorfm/aionly), with a public board for substantially AI-generated music, videos, images, apps, games, and other creations.

- Use TypeScript, React Router with server rendering, Cloudflare Workers, D1, R2 for image snapshots, Better Auth with Google sign-in, and Turnstile.
- Start with fresh accounts and a new database. There are no newsletter subscribers to migrate.
- Retire newsletter authentication, billing, and email integrations. Preserve the old database and previous deployment for rollback.
- Keep separate staging and production environments.
- Human editing and human-written comments are welcome. Incidental AI assistance does not qualify a post. NSFW content is prohibited.

### Public repository

- Start the new repository with the board code and this plan. Keep legacy newsletter history in the old repository rather than importing it wholesale.
- Keep credentials, OAuth and Turnstile secrets, local environment files, database exports, private user data, and operational logs out of the public repository and Lab session artifacts. Use environment examples with placeholders, synthetic fixtures, and deployment secret stores.
- Document local setup, required bindings and environment variables, testing, and deployment in the public README. Review staged changes for secrets and private data before publication.
- Preserve the old database archive outside the public repository. The old repository may be archived after a successful cutover and verification of the rollback path.

## Design

- **Character:** content-first and quiet. Neutral surfaces and one accent color; the media supplies the color. No gradients or glass.
- **Layout:** one 680 px column with a slim sticky header holding the logo, sort and range, Submit, theme, and avatar. Votes sit left of the card on desktop and in the card footer on mobile.
- **Type and tokens:** system font stack, four text sizes, a 4 px spacing grid, and 44 px minimum touch targets. Colors are CSS variables that meet AA contrast in both themes.
- **Components:** Tailwind with Radix primitives for the ⋯ menu, dialogs, and toasts.
- **States:** every screen defines skeleton, empty, error, pending, and rate-limited states.
- **Gate:** build a staging-only `/dev/ui` page showing every component in both themes, and agree on it before feature work starts. Exclude it from production.

## Board, accounts, and discussion

- **Feed:** minimal, responsive single column with votes, title, media or preview, description excerpt, author, age, and comment count. Use "Load more" pagination, 20 posts per page.
- **Pagination:** Top uses a ranking snapshot, because scores change while someone reads. The first load returns the ordered post IDs for that sort and range, up to 500, and each "Load more" fetches the next 20 by ID, so later votes can neither skip nor repeat posts. Posts removed since the snapshot are omitted, and the list ends at 500 with a prompt to narrow the range. New uses an opaque `(created_at, id)` cursor, which never changes. A Refresh control takes a new snapshot.
- **Back navigation:** sort and range live in the URL. Keep loaded pages and the snapshot in a client cache keyed by that URL so Back re-renders them and restores scroll position without refetching.
- **Sorting:** Top and New, with Today, Week, Month, and All time ranges. Default to **Top / Week**. Ranges filter publication dates over the previous 24 hours, 7 days, or 30 days. Top orders by net score, then newest.
- **Cold start:** with no range in the URL, the server uses the narrowest of Week, Month, and All time that has at least 10 posts, and the selector shows which. An explicitly chosen empty range shows an empty state linking to a wider range and to Submit. Seed 20–30 posts from the admin account before launch.
- **Themes:** System, Light, and Dark, with the preference remembered in a `theme` cookie. The server sets `<html data-theme>` and CSS resolves System with `prefers-color-scheme`, so no script runs and nothing flashes.
- **Footer:** on every page, show "A Chatcode Lab project" linking to [chatcode.dev](https://chatcode.dev/) and "@karulin" linking to [x.com/karulin](https://x.com/karulin). These are normal clickable site links.
- **Submission:** one URL, title, required description, and "I made this" or "I found this." Originals explain tools, prompts, or workflow; discoveries explain why they are worth sharing. Require AI-only and safe-for-work attestation.
- **Submission flow:** one page, two steps. Paste a URL and press **Check link**; the server returns the provider, duplicate status, and the card or embed as it will appear. Then complete the title (prefilled from metadata), description, "made" or "found," attestations, and Turnstile, and press Publish. Show eligibility at the top before any typing, such as "Next post available in 5 h 12 min" or "Posting is paused while your karma is below 0."
- **Duplicates:** compute a `canonical_key` at submission. Supported providers use `provider:id`, so `youtu.be`, `watch`, and `shorts` links collapse. Other URLs use the lowercased host without `www.` plus the path and query, with tracking parameters and the fragment stripped. Enforce uniqueness across every post that is live or moderator-removed, whether or not its author also deleted it. Only a post that is author-deleted and not moderator-removed frees its link. An author-deleted post cannot then be moderator-removed, which keeps the rule enforceable as one partial unique index. A duplicate shows "Already posted" with a link to the existing post and does not use the posting allowance. A link removed by a moderator stays blocked.
- **Accounts:** public browsing; Google sign-in for participation. Preserve destinations and drafts through login; drafts autosave to `localStorage`. Posts and comments require Submit afterward.
- **In-app browsers:** Google blocks sign-in inside embedded webviews. Detect Instagram, Facebook, TikTok, X, and generic Android WebView user agents. There, tapping Sign in opens a sheet explaining that Google sign-in does not work inside the app's browser, with a Copy link button, instead of starting OAuth. The link carries only the destination: drafts live in the in-app browser's storage and do not follow. When a draft exists, the sheet says so and adds a Copy draft button that copies its text for pasting after sign-in.
- **Identity:** automatically assign a unique, changeable username such as `quiet_otter_482`. First sign-in lands on a short "This is how you'll appear" step with the username editable. Public profiles show username, karma, posts, and comments; private identity details stay private.
- **Usernames:** every name ever used is a row in a `usernames` table keyed by name, so uniqueness is one constraint, old names are never recycled, and old profile links redirect. The first change is free; later changes are allowed once per 30 days. Route names and staff-like names are reserved.
- **Avatars:** default to a generated avatar: the username's first letter on a color derived from the user ID, rendered as inline SVG. Settings offers "Use my Google photo," off by default, which snapshots the photo through the image pipeline. The Google name and photo are never shown otherwise. An admin can reset an avatar to the generated default.
- **Posting allowance:** one successful publication per rolling 24 hours. Failed submissions do not count; deletion or removal does not reset the allowance. Admins are exempt, which also covers seeding.
- **Karma:** start at zero. Received upvotes add one and downvotes subtract one across posts and comments. No self-votes; one reversible vote per account per item. Negative karma blocks new posts while leaving comments and voting available.
- **Threading:** nested replies with collapse controls; siblings ordered by score, then oldest. Allow replies to depth 10. Cap visual indentation on mobile while retaining thread structure.
- **Low-score comments:** at net score **≤ −5**, hide the comment body by default behind **Show comment**. Keep its author, score, controls, and replies visible. This is reader-reversible and automatically stops applying when the score rises above −5.
- **Author controls:** edit titles, descriptions, and comments; delete own content. Published post URLs stay fixed. The title and the "made" or "found" choice are editable for 1 hour after publication. Descriptions and comments are editable any time and are marked "edited" when changed more than 5 minutes after posting. Author deletion is permanent for the author. Removed or deleted items cannot be edited.
- **Removed and deleted posts:** they leave the feed and profiles. The permalink shows **[removed by moderator]** or **[deleted by author]** with status 410 and `noindex`. Exclude the title, URL, description, preview, and embed from public HTML and loader data. Existing comments stay readable, and the thread is read-only until an admin restores the post.

### Limits

| Field | Rule |
|---|---|
| Title | 3–100 characters, single line |
| Description | 20–2,000 characters |
| Comment | 1–5,000 characters |
| Report note | Up to 500 characters |
| URL | `https` only, up to 2,048 characters |
| Username | 3–20 of `a–z 0–9 _`, starts with a letter, stored lowercase |
| Thread depth | Replies allowed to depth 10 |
| Daily ceilings (rolling 24 hours, in D1) | 100 comments, 20 reports |
| Feed page | 20 posts |

## Media and text

| Source | Presentation | Frame |
|---|---|---|
| YouTube and Shorts | Controlled embedded player | `youtube-nocookie.com/embed/<id>?enablejsapi=1` |
| TikTok | Embedded player the page can pause and resume | `tiktok.com/player/v1/<id>?autoplay=1` |
| Suno songs | Public player in the site theme, loaded on click | `suno.com/embed/<id>?theme=<theme>` |
| X/Twitter posts | Post embed in the site theme, including attached images or video, loaded on click | `platform.twitter.com/embed/Tweet.html?id=<id>&theme=<theme>` |
| Reddit posts | Compact post embed in the site theme, loaded on click | `embed.reddit.com/r/<community>/comments/<id>/?embed=true&style=subreddit-first` |
| Apps, games, and other URLs | Preview card opening the original | None |

- **Posters:** render every media card as a poster with a fixed aspect ratio: 16:9, or 9:16 capped at about 70% of the viewport height for Shorts and TikTok. Only the focused card mounts an iframe, after 300 ms of dwell, and at most two iframes are mounted at once.
- Autoplay the focused YouTube or TikTok video **muted**, with a remembered off switch. Autoplay is on by default and off under `prefers-reduced-motion` or data saver. Focus is the visible player nearest the viewport center.
- **Sound:** a tap on a poster mounts the player with sound. YouTube is unmuted by command. TikTok's player starts muted by itself and undoes mute commands from the page, so its sound comes from the player's own volume button. Never set TikTok's `muted` parameter: it also locks the volume.
- **TikTok is always mounted playing.** Mounted paused, its player sends no events and ignores every command, so there is no paused TikTok frame: an unfocused card is a poster.
- Keep one playback owner. Pause the previous controlled player; unload uncontrolled embeds when ownership changes. Pause or unload on leaving view, tab hiding, or navigation. Music requires a click.
- Always retain "Open original." Unsupported, unavailable, private, or embedding-disabled content falls back to a preview; blocked autoplay shows Play.
- Fetch and store bounded Open Graph metadata server-side at the Check link step. Missing metadata produces a title/domain card. Preview failure does not prevent publication.
- **Preview images:** at the Check link step, fetch the thumbnail once and store it in R2 under a random key, recorded in an `images` table as pending and owned by the submitter. Accept JPEG, PNG, or WebP by magic bytes, at most 2 MB, within 5 seconds. Use this for supported providers too, since their thumbnail URLs can expire. Failures fall back to the title/domain card.
- **Image visibility:** `/img/<key>` checks the reference on every request. It serves an image only while it is attached to a post that is neither removed nor deleted, or is a current avatar. A pending image is served only to its owner, with `Cache-Control: private, no-store`. Anything else returns 404.
- **Image caching:** serve public images with `Cache-Control: public, max-age=300` and `nosniff`, never `immutable`, and do not store them in the edge cache. A removal then takes effect at once for new requests and within 5 minutes for browsers that already loaded the image.
- **Image cleanup:** each account holds at most one pending image; a new Check link replaces it. Publishing attaches the image in the same batch as the post. A scheduled sweep deletes pending images older than 24 hours and the images of author-deleted posts and deleted accounts. Moderator removal hides the image but keeps the object so restoration works; an admin purge deletes the object for content that must not be retained.
- Generate embeds through provider adapters; accept URLs rather than submitted HTML. Build each frame URL from the validated provider ID.
- **No provider scripts in the page:** every embed is a plain sandboxed iframe. Control YouTube by `postMessage` directly instead of loading the IFrame API script, and TikTok through its official player `postMessage` API. Suno, X, and Reddit need no control; X and Reddit report their height by message. Only TikTok's protocol is documented; the others were confirmed against the live frames in the embed spike.
- **Minimal and themed:** request each provider's most compact presentation, and pass the site's color scheme wherever the provider has one: X and Suno take `theme`, Reddit takes `theme=dark` and is light otherwise. YouTube and TikTok have no theme. A mounted frame is rebuilt when the site theme changes.
- **Post embed layout:** X and Reddit frames stop at the provider's own width (550 px and 640 px), are centered, and take the height the embed reports. X's frame is transparent and never declares a dark color scheme, so its iframe is marked `color-scheme: light`; otherwise the browser paints a white backdrop behind it on a dark page.
- **No script fallback:** a provider whose frame fails falls back to the preview card. A first-party shell that ran the provider's own script in a sandbox was built and rejected: X's and Instagram's scripts load there but cannot complete their frame messaging at an opaque origin. A shell would need its own hostname.
- **Instagram is not supported.** It blocks embedding for some posts and ignores the site theme. Instagram links are ordinary preview cards.
- Accept both `x.com` and `twitter.com` post URLs and normalize them by post ID. Treat X/Twitter embeds as uncontrolled media: click to load, participate in the single playback owner, and unload on ownership changes. Retain the preview fallback for unavailable posts or blocked embeds.
- Accept Reddit post URLs from any `reddit.com` host and normalize them by post ID; a comment permalink resolves to its post. The frame needs the community, so links without one (`redd.it`, `/comments/<id>`, share links) are resolved server-side at the Check link step. Reddit embeds are uncontrolled media, handled like X.
- Allow limited Markdown: emphasis, lists, quotes, and code blocks. **Links in descriptions and comments remain non-clickable.** Display Markdown links as `label (URL)`, leave plain URLs inert, disable inline images, and escape HTML.
- Main post links, preview cards, site navigation, and native provider controls remain interactive. Post links and preview cards use `rel="nofollow ugc noopener"` and `target="_blank"`, show the destination domain beside the title, and send an origin-only referrer (`strict-origin-when-cross-origin`).
- **Sharing:** post pages emit `og:title`, a 160-character excerpt, the snapshot image, and a canonical `/p/<id>`. Tombstones emit generic tags.

## Reports, reversible moderation, and abuse protection

### Reporting

- Put **Report only in the ⋯ menu**, regardless of score, for posts, comments, and users. User reporting is accessible from profiles and author menus.
- A report opens a small dialog with a reason and optional explanation. Offer reasons appropriate to the target, including NSFW, spam, abuse, vote manipulation, and insufficient AI involvement.
- Require sign-in and allow one open report per reporter/target. Repeated submissions return the existing report.
- Store a snapshot of the reported text with the report, so a later edit does not erase the evidence.
- Reports enter an admin queue; they do not automatically remove content or ban accounts.
- Each new report sends a background POST to a `REPORT_WEBHOOK_URL` secret with the target type, reason, and a queue link, without reporter identity or content. Show the open-report count in the admin navigation.
- Use user karma **≤ −10** as an admin low-karma filter. Both negative thresholds are configurable.

### Moderation

- **Admins:** keep `role` and `banned_at` on the board's own `profiles` table rather than using Better Auth's admin plugin. Grant the first admin with a documented one-line `wrangler d1 execute` per environment; there is no in-app role granting. `/admin/*` returns 404 to everyone else.
- Store bans, moderator removals, author deletions, and vote invalidation as separate flags. Moderation does not hard-delete records.
- Provide inline **Remove comment** with Undo, post removal controls, and **Ban user** from author menus and profiles.
- Ban confirmation includes an unchecked **Remove all their comments** option and the affected count.
- Banning blocks participation, including through existing sessions, and flags the user's cast votes as invalidated. Recalculate affected scores and karma.
- **Ban enforcement:** two server guards. `requireAccount()` checks the session with the cookie cache off and covers account actions: sign-out and account deletion, which keep their ownership checks. `requireParticipant()` adds `banned_at` and `role` from D1 and covers every other action, including posts, comments, votes, reports, edits, and profile changes. Repeat the ban condition inside participation write statements so a ban landing mid-request still wins. Banned users can sign in, browse, see a notice with the reason, sign out, and delete their account.
- Bulk removal flags that user's comments across the board while preserving other users' replies.
- Removed comments show **[removed by moderator]**; author-deleted comments show **[deleted by author]**. Preserve thread position and replies. Exclude original text from public HTML, APIs, excerpts, and profiles.
- Admin-removed comments cannot be revealed with Show comment. Admin restoration makes them visible again, subject to normal score-based collapse.
- Unbanning restores participation. Separate admin controls restore invalidated votes or comments from a specific moderation action.
- Record action/batch IDs so restoration preserves independent removals and author deletions. Record actor, target, time, and reason.
- Removing or deleting content preserves the contribution of votes it received; removed or deleted items accept no further votes. Invalidating or restoring cast votes reverses or reapplies their contribution exactly once.
- Scores and karma are derived values. Recompute them from the votes table inside the same batch as the change rather than incrementing, so "exactly once" holds by construction and a recompute repairs any drift.

### Basic throttling

| Action | Per account / minute | Per IP / minute |
|---|---:|---:|
| Vote changes | 30 | 120 |
| New comments | 5 | 20 |
| Submission attempts, reports, and other public writes | 10 combined | 30 combined |
| Sign-in initiation | — | 10 |

- Use Workers rate-limiting bindings for approximate burst protection per Cloudflare location; the binding supports only 10- or 60-second periods. Keep vote uniqueness and posting eligibility authoritative in D1. [Cloudflare rate-limiting documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- Enforce the daily ceilings from the limits table in D1.
- Derive hashed IP keys from trusted `CF-Connecting-IP`, keying IPv6 by /64; avoid raw-IP application logs. Shared-IP users can participate within the shared allowance. Cloudflare advises against IP keys, so IP limits stay a loose backstop behind the per-account limits.
- The Check link endpoint requires sign-in and counts as a submission attempt.
- Return `429` with retry guidance, preserve drafts, and revert rejected optimistic votes. Repeated vote-change requests count toward throttling.
- Require server-validated Turnstile on post submission, checking success, hostname, and action. Refresh expired challenges without losing drafts.
- Enforce sessions, roles, bans, ownership, karma, and cooldown on the server.

### Security baseline

- **Scripts:** the top-level document runs only first-party scripts, with Turnstile as the single exception. Provider code runs only inside provider frames.
- **Content Security Policy:** send the site policy on every response, with `script-src 'self' 'nonce-…' https://challenges.cloudflare.com`, `frame-src` limited to the five providers and Turnstile, `frame-ancestors 'none'`, and `base-uri 'self'`. No first-party page is ever framed.
- **Embed frames:** every embed iframe uses `sandbox` without `allow-top-navigation`. Message listeners check `event.origin` and `event.source`, and commands are posted to the provider's origin alone.
- **Requests:** use React Router 7.15.1 or later and POST for every mutation, including sign-out. Reject any non-GET request whose `Origin` is not the site origin, because the built-in check is described as covering UI routes only.
- **Cookies:** session cookies are host-only. Do not set a cookie domain, unlike the legacy configuration.
- **Return destination:** it must parse as a same-origin path starting with a single `/`; anything else becomes `/`.
- **Private fields:** public queries read only `profiles`, never Better Auth's `user` table. Loaders return objects built by explicit mappers such as `toPublicPost`.
- **Server fetches:** `https` on the default port, public DNS names only, manual redirects re-validated up to 3 hops, 5 seconds total, at most 512 KB of `text/html`, and no cookies.

## Privacy and legal pages

- Publish new `/privacy`, `/terms`, and `/rules` pages with a contact address for abuse and takedowns. The legacy privacy and terms pages describe a paid newsletter and do not carry over.
- The privacy page states what Google provides, what is public, and that YouTube and TikTok are contacted when their player comes into view.
- **Account deletion:** Settings has "Delete account" with typed confirmation. Auth records are deleted and the profile becomes `[deleted]`. Content stays under that name unless the user ticks "also delete my posts and comments."
- Keep a keyed hash of the Google account ID for 30 days after deletion, or indefinitely if the account was banned, and refuse sign-up while it matches. Otherwise deleting and returning resets bans, karma, and the posting allowance.

## Implementation, validation, and launch

### Routes and data

- Add feed, post, submit, profile, settings, rules, privacy, terms, and admin pages. Server actions cover publication, replies, votes, edits/deletions, reports, bans, removal, and restoration. Authentication uses `/api/auth/*`.

```
/                     feed (?sort=top|new&range=day|week|month|all)
/p/:id                post and thread (comment anchors #c-<id>)
/submit  /settings  /rules  /privacy  /terms
/u/:username          profile
/admin  /admin/users  /admin/log
/api/auth/*  /img/:key
/dev/ui               staging only
```

- Store auth records, profiles, posts, parent-linked comments, votes, reports, and moderation history, including independent flags and moderation batch membership. IDs are short random strings, not sequential.

```
user, session, account, verification    Better Auth; never read by public queries
profiles(user_id, karma, role, banned_at, ban_reason, avatar_key, deleted_at)
usernames(name PK, user_id, is_current)
posts(id, author_id, url, canonical_key, provider, kind, title, description,
      thumb_key, aspect, score, comment_count, created_at, edited_at,
      deleted_at, removed_batch_id)
comments(id, post_id, parent_id, author_id, body, depth, score,
         created_at, edited_at, deleted_at, removed_batch_id)
votes(voter_id, target_type, target_id, value, invalidated_batch_id)
images(key PK, owner_id, kind, state, content_type, bytes, created_at)
reports(id, reporter_id, target_type, target_id, reason, note, snapshot, status)
mod_actions(id, batch_id, actor_id, action, target_type, target_id, reason,
            created_at, reverted_at)
deleted_identities(id_hash PK, banned, deleted_at)
```

- Use unique voter/target constraints and atomic D1 operations for scores, karma, posting eligibility, bans, bulk removal, and restoration. Concurrent requests must not bypass restrictions or produce partial moderation results. D1 has no interactive transactions; use conditional statements inside `batch()`, which is transactional.
- Use Better Auth 1.5 or later, which supports D1 natively.
- Validate public URLs and redirects, bound metadata-fetch time and size, sanitize rendering, and restrict embedded frames to supported providers.

### Build order

1. Spike: deploy a skeleton to staging and test all five embeds on real phones. Desktop Chromium has confirmed the frame URLs and message formats; phones still need to confirm autoplay, sound after a tap, TikTok playback, and in-app browser detection. Also confirm which providers return usable metadata and thumbnails from Workers.
2. Read path with seeded data and the design system, including the `/dev/ui` gate.
3. Sign-in, username, submission, votes, and karma.
4. Comments and author controls.
5. Reports, moderation, and rate limits.
6. Autoplay and playback ownership, then cutover.

### Validation

- Use Vitest with Cloudflare's Workers pool for D1 integration tests, Playwright for end-to-end tests, and Turnstile's test keys locally and in CI. Tests create sessions by inserting rows; no build contains a test-login route.
- Test ranking, date boundaries, concurrent voting/submissions, throttling, shared-IP use, karma recovery, login drafts, and permissions.
- Test −5 collapse and recovery, reports at every score exclusively through menus, reversible bans/removals, vote invalidation/restoration, surviving replies, and preservation of independent removals.
- Test duplicate submissions across URL variants, tombstones for removed and deleted posts, edit windows, username rules and redirects from old names, daily ceilings, and the cold-start range choice.
- Test that a post both moderator-removed and author-deleted still blocks its link, and that an author-deleted post cannot be moderator-removed.
- Test that Top pagination neither skips nor repeats posts when scores change between pages, and that Refresh takes a new snapshot.
- Test image visibility: pending images reach only their owner, images of removed or deleted posts return 404, public images are never served as `immutable`, and the sweep deletes expired pending images.
- Test account deletion, the sign-up block for deleted and banned identities, and ban enforcement when a ban lands mid-request. A banned user can sign out and delete their account, and every participation action is refused.
- Test that no page can be framed, that frames follow the site theme and are rebuilt on a theme switch, and that only the commands a player obeys are offered.
- Test that the in-app browser sheet offers Copy draft when a draft exists.
- Verify removed text never reaches public responses and submitted links never become clickable.
- Seed sentinel strings for email, Google name, and removed text, crawl every public route as an anonymous user and as a different user, and assert none appear in HTML or data responses.
- Verify the Content Security Policy on every response, rejection of cross-origin non-GET requests, and the fallback to `/` for return destinations outside the site.
- Test playback handoff, failed previews, mobile layouts, keyboard access, themes, migrations, and production builds.
- Test back navigation restoring loaded pages and scroll position, the in-app browser sheet, the theme cookie rendering without a flash, autoplay staying off under reduced motion, and the two-iframe cap.
- Test X/Twitter URL variants, posts with text/images/video, playback handoff, and preview fallback for deleted, protected, or unavailable posts and blocked embeds.
- Test Reddit URL variants, including comment permalinks and links without a community, and the compact themed frame.
- Verify the Chatcode and X footer links on all page types and confirm that public source, fixtures, and documentation contain no credentials or private user data.

### Cutover

- Validate on staging, configure production Google callbacks and Turnstile domains, switch `aion.ly`, and monitor errors, rejected writes, and moderation activity. Staging sends `X-Robots-Tag: noindex` on every response.

1. Confirm there are no active, trialing, or past-due subscriptions in Stripe live mode.
2. Export the old D1 database to private storage and record the current Pages and Worker deployment IDs.
3. Rehearse the switch and the rollback on `dev.aion.ly`.
4. Remove the legacy Worker's routes on `aion.ly` (`/my/*`, `/subscribe/*`, `/webhooks/*`, and `/health`), detach the domain from the Pages project, and attach it to the new Worker.
5. Disable the Stripe webhook endpoint and the SNS subscription, and stop the queue consumer.
6. After a 30-day rollback window, delete the old resources and revoke the Stripe and SES credentials.

### Coverage

- When the board ships, publish project coverage at [chatcode.dev/lab/](https://chatcode.dev/lab/) describing the Lab sessions, shipped functionality, and lessons learned, with links to the live `aion.ly` board and public `chatcode-lab/aionly` repository. Use public-safe screenshots and examples.

Defer uploads, Gravatar, search, categories, notifications, messaging, automated content detection, and coordinated-voting detection beyond these basic controls. Server-made image snapshots are not user uploads. Facebook and Telegram embeds can follow as further provider adapters.

### Later: media uploads

Not in the MVP, but the design leaves room so adding them needs no redesign.

- **What:** pictures, video, and audio hosted by the board, for creations that live nowhere else. Such a post has no outside link; its title opens the post page.
- **Who:** off for everyone at first. Unlock by karma threshold, with a paid option as a possible alternative. Either way it is one configurable gate checked by `requireParticipant()`.
- **Feed:** the same post card. A picture keeps its own shape, capped in height and never cropped. Video uses the same poster as a provider video and plays in the browser's own player. Audio uses the same row as a provider song. The `/dev/ui` page shows all three.
- **Storage:** the `images` pipeline generalizes: R2 objects under random keys, pending until published, served only while attached to a live post, never `immutable`, swept when orphaned. Add `media-src 'self'` to the policy.
- **Open before building:** size and length limits, transcoding and poster extraction, how uploads are screened for NSFW content when there is no provider doing it first, and storage and bandwidth cost.
