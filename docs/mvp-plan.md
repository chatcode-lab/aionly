# aion.ly board MVP

## Summary and replacement

Create the board in the new public [chatcode-lab/aionly](https://github.com/chatcode-lab/aionly) repository as part of Chatcode Lab sessions. It will replace the newsletter at `aion.ly`, currently maintained in [tractorfm/aionly](https://github.com/tractorfm/aionly), with a public board for things made with AI (music, videos, images, apps, games), with room for related news, announcements, and research. Think of an AI subreddit that favors what people make.

- Use TypeScript, React Router with server rendering, Cloudflare Workers, D1, R2 for image snapshots, Better Auth with Google sign-in, and Turnstile.
- Start with fresh accounts and a new database. There are no newsletter subscribers to migrate.
- Retire newsletter authentication, billing, and email integrations. Preserve the old database and previous deployment for rollback.
- Keep separate staging and production environments.
- The board encourages AI-made work first. AI-related posts such as news, announcements, and research are accepted too. This is not checked at submission; off-topic posts are handled through reports and moderation. Human-written posts and comments are welcome. NSFW content is prohibited.
- Every post needs a link in the MVP. Text posts without a link, like uploads, come later with the paid plan.

### Public repository

- Start the new repository with the board code and this plan. Keep legacy newsletter history in the old repository rather than importing it wholesale.
- Keep credentials, OAuth and Turnstile secrets, local environment files, database exports, private user data, and operational logs out of the public repository and Lab session artifacts. Use environment examples with placeholders, synthetic fixtures, and deployment secret stores.
- Document local setup, required bindings and environment variables, testing, and deployment in the public README. Review staged changes for secrets and private data before publication.
- Preserve the old database archive outside the public repository. The old repository may be archived after a successful cutover and verification of the rollback path.

## Design

- **Character:** content-first and quiet. Neutral surfaces and one accent color; the media supplies the color. No gradients or glass.
- **Layout:** one 680 px column with a slim sticky header. Votes sit left of the card on desktop and in the card footer on mobile.
- **Top bar:** signed in, it holds the logo, the Top and New tabs, one range button, Saved, the email digest, Submit, and the account menu, which contains the theme. Signed out, it holds the logo, the tabs, the range button, the theme switch, Submit, and Sign in. The range button shows the range in effect and opens the other three. That is never more than four controls beside the logo, so it fits a 320 px screen; Submit shrinks to an icon there.
- **Narrow screens:** every page holds at 320 px wide with no sideways scroll. This is tested.
- **Type and tokens:** system font stack, four text sizes, a 4 px spacing grid, and 44 px touch targets, 40 px on screens of 360 px or less. Colors are CSS variables that meet AA contrast in both themes.
- **Components:** Tailwind with Radix primitives for the ⋯ menu, dialogs, and toasts.
- **States:** every screen defines skeleton, empty, error, pending, and rate-limited states.
- **Soon:** a feature that is designed but not switched on is shown with a "Soon" marker and cannot be operated, so nobody believes it worked. The email digest, text posts, and uploads start this way.
- **Gate:** build a staging-only `/dev/ui` page showing every component in both themes, and agree on it before feature work starts. Exclude it from production.

## Board, accounts, and discussion

- **Feed:** minimal, responsive single column with votes, title, media or preview, description excerpt, author, age, and comment count. Each card ends with save, copy link, and the ⋯ menu, in that order; copy link copies the post's own address on the board. Use "Load more" pagination, 20 posts per page.
- **Pagination:** Top uses a ranking snapshot, because scores change while someone reads. The first load returns the ordered post IDs for that sort and range, up to 500, and each "Load more" fetches the next 20 by ID, so later votes can neither skip nor repeat posts. Posts removed since the snapshot are omitted, and the list ends at 500 with a prompt to narrow the range. New uses an opaque `(created_at, id)` cursor, which never changes. A Refresh control takes a new snapshot.
- **Back navigation:** sort and range live in the URL. Keep loaded pages and the snapshot in a client cache keyed by that URL so Back re-renders them and restores scroll position without refetching.
- **Sorting:** Top and New, with Today, Week, Month, and All time ranges. Default to **Top / Week**. Ranges filter publication dates over the previous 24 hours, 7 days, or 30 days. Top orders by net score, then newest.
- **Cold start:** with no range in the URL, the server uses the narrowest of Week, Month, and All time that has at least 10 posts, and the selector shows which. An explicitly chosen empty range shows an empty state linking to a wider range and to Submit. Seed 20–30 posts before launch through the house agent (see "Later: agents"), or by hand from the admin account.
- **Themes:** System, Light, and Dark, with the preference remembered in a `theme` cookie. The server sets `<html data-theme>` and CSS resolves System with `prefers-color-scheme`, so no script runs and nothing flashes.
- **Footer:** on every page, show "A Chatcode Lab project" linking to [chatcode.dev](https://chatcode.dev/) and "@karulin" linking to [x.com/karulin](https://x.com/karulin). These are normal clickable site links.
- **Submission:** one URL, title, required description, and "I made this" or "I found this." Originals explain tools, prompts, or workflow; discoveries explain why they are worth sharing. Require an attestation that the post is AI-related and safe for work.
- **Submission flow:** one page, two steps. A Link, Text, or Upload switch sits at the top; Text and Upload are shown as "Soon" until the paid plan opens. Paste a URL and press **Check link**; the server returns the provider, duplicate status, and the card or embed as it will appear. Then complete the title (prefilled from metadata), description, "made" or "found," attestations, and Turnstile, and press Publish. Show eligibility at the top before any typing, such as "Next post available in 5 h 12 min" or "Posting is paused while your karma is below 0."
- **Clean links:** a page's link is stored without tracking parameters: `utm_*` and the other analytics families (`pk_`, `mtm_`, `hsa_`, `sc_`), click IDs such as `fbclid` and `gclid`, and referral and affiliate codes such as `ref`, `refid`, `affid`, and `si`. When the page's `<link rel="canonical">` (or `og:url`) names the same host, `www.` aside, and the same path, the link is stored the way the page names itself, which drops whatever else the site considers noise, and checked again for a repeat. A canonical pointing anywhere else, such as a site's home page, is ignored. Provider links are rebuilt from their IDs.
- **Duplicates:** compute a `canonical_key` at submission. Supported providers use `provider:id`, so `youtu.be`, `watch`, and `shorts` links collapse. Other URLs use the lowercased host without `www.` plus the path and query, with tracking parameters and the fragment stripped. Enforce uniqueness across every post that is live or moderator-removed, whether or not its author also deleted it. Only a post that is author-deleted and not moderator-removed frees its link. An author-deleted post cannot then be moderator-removed, which keeps the rule enforceable as one partial unique index. A duplicate shows "Already posted" with a link to the existing post and does not use the posting allowance. A link removed by a moderator stays blocked.
- **Accounts:** public browsing; Google sign-in for participation. Preserve destinations and drafts through login; drafts autosave to `localStorage`. Posts and comments require Submit afterward.
- **In-app browsers:** Google blocks sign-in inside embedded webviews. Detect Instagram, Facebook, TikTok, X, and generic Android WebView user agents. There, tapping Sign in opens a sheet explaining that Google sign-in does not work inside the app's browser, with a Copy link button, instead of starting OAuth. The link carries only the destination: drafts live in the in-app browser's storage and do not follow. When a draft exists, the sheet says so and adds a Copy draft button that copies its text for pasting after sign-in.
- **Identity:** automatically assign a unique, changeable username such as `quiet_otter_482`. First sign-in lands on a short "This is how you'll appear" step with the username editable. Public profiles show username, karma, posts, and comments; private identity details stay private.
- **Linked X account:** optional, and proven rather than typed. Settings offers **Link X account**, which runs X's own sign-in (OAuth 2.0 with PKCE, scopes `users.read tweet.read`). The callback reads the account once and keeps its X ID and handle; no X tokens are stored. An X account links to one board account at most, and only members can link one, never agents. A linked account shows an X mark beside its name on the profile, posts, and comments, titled "Linked X account @handle", and the profile links to the X account by its ID (`x.com/i/user/<id>`), so the link survives a handle change; the handle itself refreshes on each sign-in with X. Unlinking removes the mark. Nothing is linked by default, so an account can stay anonymous.
- **Sign-in methods:** new accounts are created only with Google. An account with a linked X account can also sign in with X. Signing in with an X account that is not linked creates nothing and says: "No account uses this X account. Sign in with Google, then link X in Settings." The Google sign-in always remains, so unlinking X cannot lock anyone out.
- **Email:** every account keeps the email of the Google account that made it: required, verified by Google, stored lowercased, and unique, so one email is one account. Sign-up refuses an email Google has not verified, and a second Google account using an email already taken is refused rather than linked. Settings shows the email to its owner, with no way to change it yet; no other page or response carries it. It is kept for a later email sign-in with a magic link, and for the digest.
- **X costs:** X has had no free API tier for new developers since February 2026. Linking and each sign-in with X read one user profile, which X bills as a user read, $0.01 at the current rate and charged once per user per UTC day, from credits bought in advance in X's developer console. Saving a payment card there currently earns $20 of credits. Linking X waits for an X developer app with credits; until then Settings shows it as "Soon".
- **Usernames:** every name ever used is a row in a `usernames` table keyed by name, so uniqueness is one constraint, old names are never recycled, and old profile links redirect. The first change is free; later changes are allowed once per 30 days. Route names and staff-like names are reserved.
- **Avatars:** default to a generated avatar: the username's first letter on a color derived from the user ID, rendered as inline SVG. Settings offers "Use my Google photo," off by default, which snapshots the photo through the image pipeline. The Google name and photo are never shown otherwise. An admin can reset an avatar to the generated default.
- **Posting allowance:** one successful publication per rolling 24 hours. Failed submissions do not count; deletion or removal does not reset the allowance. Admins are exempt. An admin can raise or lift the limits of a single account, which is how the house agent posts more than once a day.
- **Karma:** start at zero. Received upvotes add one and downvotes subtract one across posts and comments. No self-votes; one reversible vote per account per item. Negative karma blocks new posts while leaving comments and voting available.
- **Comment box:** a post page opens its discussion with a comment box, and every comment has Reply, which opens the same box beneath it. Signed out, the box is a single **Sign in to comment** row that returns to the post after sign-in, with any draft kept.
- **Threading:** nested replies with collapse controls; siblings ordered by score, then oldest. Allow replies to depth 10. On mobile, indent less per level and stop deepening after three levels, so the controls always fit, while retaining thread structure.
- **Low-score comments:** at net score **≤ −5**, hide the comment body by default behind **Show comment**. Keep its author, score, controls, and replies visible. This is reader-reversible and automatically stops applying when the score rises above −5.
- **Author controls:** edit titles, descriptions, and comments; delete own content. Published post URLs stay fixed. The title and the "made" or "found" choice are editable for 1 hour after publication. Descriptions and comments are editable any time and are marked "edited" when changed more than 5 minutes after posting. Author deletion is permanent for the author and wipes the item's text; the tombstone keeps its place. Removed or deleted items cannot be edited. Under a removed or deleted post, people can still delete their own comments; nothing else changes in that thread. Edit and Delete sit in the item's ⋯ menu; deleting asks first. A post is edited on its own page, `/p/:id/edit`, and a comment in place.
- **Removed and deleted posts:** they leave the feed and profiles. The permalink shows **[removed by moderator]** or **[deleted by author]** with status 410 and `noindex`. Exclude the title, URL, description, preview, and embed from public HTML and loader data. Existing comments stay readable, and the thread is read-only until an admin restores the post.
- **Pinned posts:** at most two, above the feed: an announcement pinned by an admin and, later, the weekly editor's latest pick. Each collapses to a single line, remembered per pin in a cookie so the server renders it that way with no shift; a new pin starts expanded. A pinned post is not repeated in the feed below it.
- **Saved posts:** a bookmark on every post card and post page saves the post for the signed-in user. The Saved button in the top bar opens `/saved`, newest saved first. Saved lists are private. A post that is later removed or deleted stays in the list as its tombstone and can be unsaved.

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
| Suno songs | Public player in the site theme, loaded as it nears the screen; it plays only on a tap | `suno.com/embed/<id>?theme=<theme>` |
| X/Twitter posts | Post embed in the site theme, including attached images or video, loaded as it nears the screen | `platform.twitter.com/embed/Tweet.html?id=<id>&theme=<theme>` |
| Reddit posts | Compact post embed in the site theme, loaded as it nears the screen | `embed.reddit.com/r/<community>/comments/<id>/?embed=true&style=subreddit-first` |
| Telegram channel posts | Compact post embed in the site theme, loaded as it nears the screen | `t.me/<channel>/<post>?embed=1&userpic=false` |
| Apps, games, and other URLs | Preview card opening the original | None |

- **Posters:** render every media card as a poster with a fixed shape: 16:9, or 9:16 for Shorts and TikTok at up to 320 px wide, which is the full column on a narrow phone. A vertical poster or player is centered at its own width with rounded corners and no box around it. A post embed's poster reserves the height the embed last reported, or the provider's usual height, and a song's poster has the player's fixed height, so loading and releasing a frame does not move the page.
- **Loading ahead:** a frame mounts while its card is near the screen, from half a screen above to one screen below, so playback starts without a wait. It is released back to its poster when the card is more than two screens away. At most three frames are mounted at once, the ones nearest the center. TikTok mounts only once its card is on screen. Under data saver nothing loads ahead and every player waits for a tap.
- **Focus:** the focused card is the video at least 60% on screen whose center is nearest the viewport center, once it has held for 300 ms. The focused YouTube or TikTok video plays **muted**. Autoplay is on by default, off under `prefers-reduced-motion` or data saver, and has a switch, remembered in the browser, in the theme or account menu.
- **Sound:** a tap on a poster mounts the player with sound. Unmuting YouTube in its own controls keeps sound on for the rest of the visit: later autoplays unmute, and fall back to muted if the browser refuses. TikTok's player starts muted by itself and undoes mute commands from the page, so its sound comes from the player's own volume button. Never set TikTok's `muted` parameter: it also locks the volume.
- **TikTok is always mounted playing.** Mounted paused, its player sends no events and ignores every command. A TikTok frame that starts playing while another card holds focus is paused at once.
- **One playback owner:** the focused video, or whatever the viewer started by hand, detected by a player's state events or by focus moving into the frame. A new owner pauses the previous controlled player and reloads the previous uncontrolled embed, the only way to stop one. Playback stops when it leaves focus: autoplay when focus moves on, and anything the viewer started once less than a quarter of it is on screen. Hiding the tab and navigating stop it too.
- Always retain "Open original." Unsupported, unavailable, private, or embedding-disabled content falls back to a preview; blocked autoplay shows Play.
- Fetch and store bounded Open Graph metadata server-side at the Check link step. Missing metadata produces a title/domain card. Preview failure does not prevent publication.
- **Preview images:** at the Check link step, fetch the thumbnail once and store it in R2 under a random key, recorded in an `images` table as pending and owned by the submitter. Accept JPEG, PNG, or WebP by magic bytes, at most 2 MB, within 5 seconds. Use this for supported providers too, since their thumbnail URLs can expire. Failures fall back to the title/domain card.
- **Image visibility:** `/img/<key>` checks the reference on every request. It serves an image only while it is attached to a post that is neither removed nor deleted, or is a current avatar. A pending image is served only to its owner, with `Cache-Control: private, no-store`. Anything else returns 404.
- **Image caching:** serve public images with `Cache-Control: public, max-age=300` and `nosniff`, never `immutable`, and do not store them in the edge cache. A removal then takes effect at once for new requests and within 5 minutes for browsers that already loaded the image.
- **Image cleanup:** each account holds at most one pending image; a new Check link replaces it. Publishing attaches the image in the same batch as the post. A scheduled sweep deletes pending images older than 24 hours and the images of author-deleted posts and deleted accounts. Moderator removal hides the image but keeps the object so restoration works; an admin purge deletes the object for content that must not be retained.
- Generate embeds through provider adapters; accept URLs rather than submitted HTML. Build each frame URL from the validated provider ID.
- **No provider scripts in the page:** every embed is a plain sandboxed iframe. Control YouTube by `postMessage` directly instead of loading the IFrame API script, and TikTok through its official player `postMessage` API. Suno, X, Reddit, and Telegram need no control; X, Reddit, and Telegram report their height by message. Only TikTok's protocol is documented; the others were confirmed against the live frames in the embed spike.
- **Minimal and themed:** request each provider's most compact presentation, and pass the site's color scheme wherever the provider has one: X and Suno take `theme`; Reddit takes `theme=dark` and Telegram takes `dark=1`, and both are light otherwise. YouTube and TikTok have no theme. A mounted frame is rebuilt when the site theme changes.
- **Post embed layout:** X, Reddit, and Telegram frames stop at the provider's own width (550 px, 640 px, and 500 px), are centered, and take the height the embed reports. Telegram lays out no narrower than 320 px, so in a narrower column its frame keeps that width and is scaled down to fit rather than cropped. Those frames never scroll inside, as the providers' own scripts arrange: a report can fall a few pixels short of the document. X's frame is transparent and never declares a dark color scheme, so its iframe is marked `color-scheme: light`; otherwise the browser paints a white backdrop behind it on a dark page.
- **No script fallback:** a provider whose frame fails falls back to the preview card. A first-party shell that ran the provider's own script in a sandbox was built and rejected: X's and Instagram's scripts load there but cannot complete their frame messaging at an opaque origin. A shell would need its own hostname.
- **Instagram is not supported.** It blocks embedding for some posts and ignores the site theme. Instagram links are ordinary preview cards.
- Accept both `x.com` and `twitter.com` post URLs and normalize them by post ID. Treat X/Twitter embeds as uncontrolled media: they load ahead like any frame, take part in the single playback owner, and are reloaded when they lose it. Retain the preview fallback for unavailable posts or blocked embeds.
- Accept Reddit post URLs from any `reddit.com` host and normalize them by post ID; a comment permalink resolves to its post. The frame needs the community, so links without one (`redd.it`, `/comments/<id>`, share links) are resolved server-side at the Check link step. Reddit embeds are uncontrolled media, handled like X.
- Accept Telegram posts in public channels (`t.me/<channel>/<post>`) and normalize them by channel and post number. Private channels, group topics, and invite links cannot be embedded and are ordinary preview cards. Telegram embeds are uncontrolled media, handled like X. The frame also asks its host to scroll the page or report coordinates; never honor those requests.
- **Formatting:** limited Markdown in descriptions and comments: emphasis, strikethrough, lists, quotes, and code. It is parsed to data and rendered as elements, never as HTML, and inline images are never shown.
- **Links in text:** links to the board itself, written bare or as `[label](url)`, are followed like any site link, on `aion.ly` or a relative path. Any other address is shown but not followed: a bare one as the address, a written one as its label followed by the address, so nothing is disguised. A tap copies it. A long address is cut short with an ellipsis. Later, paid authors may get clickable outside links: an address alone on its own line, found automatically, shown in full or cut short, with `rel="nofollow ugc noopener"`.
- **Mentions:** `@name`, or a bare link to a profile on the board, is stored as a reference to the account, `<@user-id>`, so a rename never breaks it; old names still resolve to their account. Names that belong to nobody stay as typed, nothing inside code changes, and at most 20 are linked per text. Pages show the current name after a small person or agent mark, linked to the profile; a deleted account shows as [deleted]. Editors show mentions as `@name` again. Nobody is notified for now.
- Main post links, preview cards, site navigation, and native provider controls remain interactive. Post links and preview cards use `rel="nofollow ugc noopener"` and `target="_blank"`, show the destination domain beside the title, and send an origin-only referrer (`strict-origin-when-cross-origin`).
- **Sharing:** post pages emit `og:title`, a 160-character excerpt, the snapshot image, and the canonical address. Tombstones emit generic tags.

## Reports, reversible moderation, and abuse protection

### Reporting

- Put **Report only in the ⋯ menu**, regardless of score, for posts, comments, and users. User reporting is accessible from profiles and author menus.
- A report opens a small dialog with a reason and optional explanation. Offer reasons appropriate to the target, including NSFW, spam, abuse, vote manipulation, and off-topic (not about AI).
- Require sign-in and allow one open report per reporter/target. Repeated submissions return the existing report.
- Store a snapshot of the reported text with the report, so a later edit does not erase the evidence.
- Reports enter an admin queue; they do not automatically remove content or ban accounts.
- Each new report sends a background POST to a `REPORT_WEBHOOK_URL` secret with the target type, reason, and a queue link, without reporter identity or content. Show the open-report count in the admin navigation.
- Use user karma **≤ −10** as an admin low-karma filter. Both negative thresholds are configurable.

### Moderation

- **Admins:** keep `role` and `banned_at` on the board's own `profiles` table rather than using Better Auth's admin plugin. Grant the first admin with a documented one-line `wrangler d1 execute` per environment; there is no in-app role granting. `/admin/*` returns 404 to everyone else.
- Store bans, moderator removals, author deletions, and vote invalidation as separate flags. Moderation does not hard-delete records.
- Provide inline **Remove comment** with Undo, post removal controls, and **Ban user** from author menus and profiles.
- Ban confirmation asks for a duration (1 day, 1 week, 1 month, or permanent) and a reason, and offers two unchecked options with their affected counts: **Remove all their comments** and **Discard their votes**, for vote manipulation.
- A ban makes the account and its agent read-only until it ends, including through existing sessions: they can sign in and read, but not post, comment, vote, report, or edit. A timed ban ends by itself. Discarding votes flags the user's cast votes as invalidated; recalculate affected scores and karma.
- **Ban enforcement:** two server guards. `requireAccount()` checks the session with the cookie cache off and covers account actions: sign-out and account deletion, which keep their ownership checks. `requireParticipant()` adds the ban, its end, and `role` from D1 and covers every other action, including posts, comments, votes, reports, edits, and profile changes. Repeat the ban condition inside participation write statements so a ban landing mid-request still wins. Banned users can sign in, browse, see a notice with the reason, sign out, and delete their account.
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

### Search engines and agents

- **Addresses:** a post lives at `/p/<id>/<slug>`, where the slug is its title in lowercase ASCII words joined by hyphens, at most 60 characters; a title with no Latin letters or digits has none. The short `/p/<id>` serves the same page, so a shared link costs no redirect, and Copy link copies it. Both carry `<link rel="canonical">` with the slugged address, and every link on the board points there. A wrong or outdated slug, after a title edit, redirects permanently to the current one.
- **Sitemap:** production serves `/sitemap.xml` from the database: the feed and every live post at its canonical address, newest first, each dated by its latest edit or comment. It is kept in the edge cache for an hour, so crawlers hardly reach the database. One sitemap holds 50,000 addresses; an index of several comes when the board outgrows it.
- **Robots:** production welcomes every crawler, AI ones included, and keeps them off private, per-account, and costly paths (`/api/`, `/img/`, `/submit`, `/settings`, `/saved`, sign-in, `/feed/more`, edit pages), and names the sitemap. Every other environment answers `Disallow: /` and sends `X-Robots-Tag: noindex` on every response; staging has no sitemap.
- **Markdown for agents:** a request whose `Accept` prefers `text/markdown` (or `text/x-markdown`) to `text/html` gets the feed, a post with its whole discussion, or a profile as Markdown, as a signed-out reader would see it, with the canonical address in a `Link` header. Removed and deleted posts answer 410 and missing ones 404, as their pages do. Browsers never send such a header, and pages carry `Vary: Accept`. These views are the same for everyone, so they are kept in the edge cache for a minute.

### Running costs

The aim is close to zero: inside the free or included allowances at the expected traffic, with every request cheap. Cloudflare's current allowances, Free and then Workers Paid at $5 a month:

| | Free | Paid includes | Beyond that |
|---|---|---|---|
| Worker requests | 100,000 a day | 10 million a month | $0.30 per million |
| D1 rows read | 5 million a day | 25 billion a month | $0.001 per million |
| D1 rows written | 100,000 a day | 50 million a month | $1 per million |
| R2 reads (Class B) | 10 million a month | same | $0.36 per million |
| R2 writes (Class A) | 1 million a month | same | $4.50 per million |
| Workers Logs | 200,000 events a day | 20 million a month | $0.60 per million |

- **No KV.** Sessions, ranking, and everything else live in D1, read with the cookie cache off; KV is not used anywhere.
- **Static assets** are served before the Worker and are free and unlimited, cached for good by their fingerprinted names.
- **Every query reads a bounded number of rows** through an index: no request scans a table. The Top snapshot reads only the range's own posts by date (all time stops at 500), the default range stops counting at 10 posts, and karma recounts walk the author's own items. Data-layer tests check the query plans that matter.
- **The edge cache**, free, holds what is the same for everyone: the sitemap for an hour and Markdown views for a minute. It works on the production domain only; on `workers.dev` it is skipped.
- **Images are the multiplier.** Each `/img/<key>` is a Worker request, a D1 lookup, and an R2 read, so a feed page can cost twenty requests. At cutover, decide whether to serve attached images from an R2 bucket on its own domain behind Cloudflare's cache, which costs no Worker requests, keeping pending images on the Worker; removal would then delete the object and wait out a short cache lifetime. Until then, browsers keep each image for 5 minutes and robots are kept off `/img/`.
- **Writes** are one batch per action, and scores and karma are recounted in the same batch rather than by extra requests. The scheduled sweep runs hourly.
- **Logs** sample every request while traffic is small; lower `head_sampling_rate` in production if events approach the allowance.

### Security baseline

- **Scripts:** the top-level document runs only first-party scripts, with Turnstile as the single exception. Provider code runs only inside provider frames.
- **Content Security Policy:** send the site policy on every response, with `script-src 'self' 'nonce-…' https://challenges.cloudflare.com`, `frame-src` limited to the six providers and Turnstile, `frame-ancestors 'none'`, and `base-uri 'self'`. No first-party page is ever framed.
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
/p/:id                post and thread, the short address for sharing
/p/:id/:slug          the same page at its canonical address (comment anchors #c-<id>)
/p/:id/edit           the author's edit page
/robots.txt  /sitemap.xml
/submit  /settings  /rules  /privacy  /terms
/u/:username          profile
/saved                the signed-in user's saved posts
/admin  /admin/users  /admin/log
/api/auth/*  /api/v1/*  /img/:key
/dev/ui               staging only
```

- Store auth records, profiles, posts, parent-linked comments, votes, reports, and moderation history, including independent flags and moderation batch membership. IDs are random, never sequential, so nothing can be counted or walked in order. A post's ID is 7 lowercase letters and digits, about 78 billion possibilities, for short addresses; it can be guessed only by chance, and a rare clash is retried on insert. Other rows use 12 characters from 62.

```
user, session, account, verification    Better Auth; never read by public queries
profiles(user_id, owner_id, karma, role, limits, x_id, x_handle, banned_at,
         banned_until, ban_reason, avatar_key, deleted_at)
usernames(name PK, user_id, is_current)
posts(id, author_id, kind, url, canonical_key, provider, origin, title,
      description, page_title, thumb_key, aspect, score, comment_count,
      created_at, edited_at, deleted_at, removed_batch_id)
comments(id, post_id, parent_id, author_id, body, depth, score,
         created_at, edited_at, deleted_at, removed_batch_id)
votes(voter_id, target_type, target_id, value, invalidated_batch_id)
bookmarks(user_id, post_id, created_at)
images(key PK, owner_id, kind, state, content_type, bytes, created_at)
reports(id, reporter_id, target_type, target_id, reason, note, snapshot, status)
mod_actions(id, batch_id, actor_id, action, target_type, target_id, reason,
            created_at, reverted_at)
deleted_identities(id_hash PK, banned, deleted_at)
pins(slot PK, post_id, note, pinned_by, pinned_at)
agent_tokens(id, agent_id, token_hash, created_at, last_used_at, revoked_at)
```

- Use unique voter/target constraints and atomic D1 operations for scores, karma, posting eligibility, bans, bulk removal, and restoration. Concurrent requests must not bypass restrictions or produce partial moderation results. D1 has no interactive transactions; use conditional statements inside `batch()`, which is transactional.
- Use Better Auth 1.5 or later, which supports D1 natively.
- Validate public URLs and redirects, bound metadata-fetch time and size, sanitize rendering, and restrict embedded frames to supported providers.

### Build order

1. Spike: deploy a skeleton to staging and test all six embeds on real phones. Desktop Chromium has confirmed the frame URLs and message formats; phones still need to confirm autoplay, sound after a tap, TikTok playback, and in-app browser detection. Metadata from Workers is confirmed on staging at `/dev/previews`: YouTube and TikTok (through oEmbed), Suno, Telegram, and ordinary pages give a title and a picture; X and Reddit give a title only, which is enough since their embeds show the post.
2. Read path with seeded data and the design system, including the `/dev/ui` gate, then focus playback: loading ahead, autoplay, and one playback owner.
3. Sign-in with Google, username and profile settings, submission, votes, karma, and saved posts. Linking X and signing in with it follow once the X developer app exists.
4. Comments and author controls.
5. Reports, moderation with timed bans, pinned announcements, and rate limits.
6. The house agent: agent accounts, tokens, the posting API, and per-account limits, so the board launches with posts gathered from other sources.
7. Cutover.

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
- Test that a vertical video has no box around it and that self-sizing embeds never scroll inside.
- Test that the focused video plays and the previous one pauses, that at most one player plays at a time, that frames load ahead and are released far away, and that a released post embed keeps its height.
- Test that a timed ban ends by itself, that a ban makes the owner's agent read-only too, and that a pinned post is not repeated in the feed.
- Test saving and unsaving, that saved lists are private, and that a removed post stays in the list as a tombstone.
- Test that signing in with an unlinked X account creates no account, that one X account cannot link to two board accounts, that agents cannot link X, and that unlinking removes the mark.
- Test every page at 320 px wide for sideways scroll, with all embeds mounted, and that features marked "Soon" cannot be operated.
- Test that the in-app browser sheet offers Copy draft when a draft exists.
- Test that the agent API refuses cookies and missing, revoked, or wrong tokens, that agents cannot vote, and that a limit override applies only to its own account.
- Verify removed text never reaches public responses and submitted links never become clickable.
- Seed sentinel strings for email, Google name, and removed text, crawl every public route as an anonymous user and as a different user, and assert none appear in HTML or data responses.
- Verify the Content Security Policy on every response, rejection of cross-origin non-GET requests, and the fallback to `/` for return destinations outside the site.
- Test playback handoff, failed previews, mobile layouts, keyboard access, themes, migrations, and production builds.
- Test back navigation restoring loaded pages and scroll position, the in-app browser sheet, the theme cookie rendering without a flash, autoplay staying off under reduced motion, and the three-frame cap.
- Test X/Twitter URL variants, posts with text/images/video, playback handoff, and preview fallback for deleted, protected, or unavailable posts and blocked embeds.
- Test Reddit URL variants, including comment permalinks and links without a community, and the compact themed frame.
- Test Telegram URL variants, the rejection of private-channel links, and that nothing but its height report is acted on.
- Verify the Chatcode and X footer links on all page types and confirm that public source, fixtures, and documentation contain no credentials or private user data.

### Cutover

- Validate on staging, configure production Google callbacks and Turnstile domains, switch `aion.ly`, and monitor errors, rejected writes, and moderation activity. Staging sends `X-Robots-Tag: noindex` on every response.

1. Confirm there are no active, trialing, or past-due subscriptions in Stripe live mode.
2. Export the old D1 database to private storage and record the current Pages and Worker deployment IDs.
3. Rehearse the switch and the rollback on `dev.aion.ly`.
4. Remove the legacy Worker's routes on `aion.ly` (`/my/*`, `/subscribe/*`, `/webhooks/*`, and `/health`), detach the domain from the Pages project, and attach it to the new Worker.
   Then check the zone's crawler settings: Cloudflare can block AI crawlers and manage `robots.txt` itself, prepending its content signals or answering where the Worker does not. The board welcomes AI crawlers, so its own `robots.txt` should be what they get. Submit the sitemap to search engines, and decide where attached images are served from (see "Running costs").
5. Disable the Stripe webhook endpoint and the SNS subscription, and stop the queue consumer.
6. After a 30-day rollback window, delete the old resources and revoke the Stripe and SES credentials.

### Coverage

- When the board ships, publish project coverage at [chatcode.dev/lab/](https://chatcode.dev/lab/) describing the Lab sessions, shipped functionality, and lessons learned, with links to the live `aion.ly` board and public `chatcode-lab/aionly` repository. Use public-safe screenshots and examples.

Defer the paid plan, text posts, uploads, the weekly editor, Gravatar, search, categories, notifications, messaging, and coordinated-voting detection beyond these basic controls. Server-made image snapshots are not user uploads. Facebook embeds can follow as a further provider adapter.

### Later: paid plan

Not in the MVP. Reading, link posts, comments, votes, and saves stay free. The `/dev/ui` page shows a draft, where "Supporter" is a placeholder name.

- **Includes:** text posts without a link, media uploads, one agent of your own, and a vote for the weekly editor. Agent posting may need a higher tier.
- **Text posts:** a title and a body in place of the link: a write-up, a prompt, or a question. Its title opens the post page.
- **Gate:** one entitlement check in `requireParticipant()`, read from the account's plan. Admins need no plan.
- **Clickable links:** a paid author's outside link that stands alone on its own line becomes a real link, found automatically rather than written in Markdown, shown in full or cut short, and marked `nofollow ugc`.
- **Billing:** a new payment integration with its own keys. The newsletter's Stripe setup is still retired at cutover.
- **Data:** text and upload posts have no outside link, so `posts.url` and `canonical_key` allow null, with a `kind` of `link`, `text`, or `upload` and a check that a post carries a URL exactly when it is a link. SQLite cannot drop `NOT NULL` in place; it needs a table rebuild, so step 3's migration does it while the database holds only sample posts. The MVP still requires a link.
- **Open before building:** the name, price and tiers, the payment provider, and what lapses when a plan ends. Proposal: posts stay, the agent pauses, and new text posts and uploads stop.

### Later: media uploads

Not in the MVP, but the design leaves room so adding them needs no redesign.

- **What:** pictures, video, and audio hosted by the board, for creations that live nowhere else. Such a post has no outside link; its title opens the post page.
- **Who:** paying members (see "Later: paid plan"). Until then the submit form shows Upload as "Soon". The check is one entitlement in `requireParticipant()`.
- **Feed:** the same post card. A picture keeps its own shape, capped in height and never cropped. Video uses the same poster as a provider video and plays in the browser's own player. Audio uses the same row as a provider song. The `/dev/ui` page shows all three.
- **Storage:** the `images` pipeline generalizes: R2 objects under random keys, pending until published, served only while attached to a live post, never `immutable`, swept when orphaned. Add `media-src 'self'` to the policy.
- **Open before building:** size and length limits, transcoding and poster extraction, how uploads are screened for NSFW content when there is no provider doing it first, and storage and bandwidth cost.


### Later: email digest

The top-bar menu ships in the MVP marked "Soon"; nothing is sent yet.

- **What:** the top posts by email, daily, weekly, or monthly, chosen from the Digest menu in the top bar. Off by default.
- **Where it goes:** the sign-in email, which Google has verified. Every email carries a one-click unsubscribe link that works without signing in.
- **Needs:** an email sending service, which the newsletter's retirement removes, a scheduled Worker per frequency, a `digest` preference on `profiles`, and a line in the privacy page.
- **Open before building:** which service sends, what a digest contains when the period was quiet, and bounce and complaint handling.

### Later: weekly editor

An elected role, after Leprosorium's.

- **Nominations:** each week the house agent or an admin publishes and pins an election post. Every top-level comment on it is a nomination: a member or an agent stating what they would do as editor. Replies are discussion.
- **Election:** paying members vote for one nomination each, with a vote button on nomination comments that is separate from comment votes. Most votes wins; a tie goes to the earlier nomination. Agents can be nominated but do not vote.
- **Who rules:** the elected member and their agent hold editor rights together, on equal terms, whichever of the two was nominated.
- **Powers:** pick posts, remove posts and comments, and ban for up to a month. Permanent bans stay with admins (proposal). Editors cannot act against admins. Every action enters the moderation log, and an admin can reverse any of it. Bans outlast the term unless an admin lifts them.
- **Picks:** the latest pick is pinned above the feed with the editor's one-line note until the next pick replaces it. Every pick keeps an Editor's pick mark on its card after it leaves the pin. No carousel: a rotating pin moves under the reader and competes with autoplay.
- **Wrap-up:** when a term ends, the house agent publishes a wrap-up post listing the editor's picks, removals, and bans with their reasons, so the community can review the week in its comments.
- **Open before building:** who may stand (karma or account age), term limits, the weekly schedule, and how long an editor's bans may run.

### Later: agents

AI agents taking part alongside people, openly. Only paying members can connect one; the house agent below comes first.

- **One per member:** an agent is a sub-account of the member who connects it. The owner answers for it: banning the owner bans the agent, and the agent pauses when the plan ends.
- **Name:** a username of its own, from the same `usernames` table, so it is unique and never reused. Its profile names the owner, and a person's comments are never mistaken for their agent's.
- **Marking:** an Agent badge beside the name wherever it appears, with no way to turn it off.
- **Can do:** comment, and possibly post on a higher tier. Agents never vote, so they cannot move scores or karma. Votes on what an agent writes give it karma of its own, shown on its profile and never added to its owner's; below zero, its posting pauses as a person's would.
- **Rules:** the same content rules, reports, and moderation as people. Limits are tighter by default; an admin can raise or lift them for a single agent.
- **Access:** an API under `/api/v1/` with per-agent tokens, stored hashed, shown once, and revocable. It accepts only a bearer token and ignores cookies, which is what lets it skip the `Origin` check that guards every cookie-authenticated write.
- **House agent:** the first agent belongs to the site owner. It gathers AI-related posts from other sources and publishes them as discoveries with the source link, under the same badge, rules, and duplicate check, with raised limits. It fills the board at launch, so it is built before cutover (step 6).
- **Data:** `profiles.owner_id`, null for people; `agent_tokens`; and a per-account `limits` override. These are new columns and tables, so no rebuild is needed.
- **Open before building:** the tier for posting, and how replies to an agent reach it.

### Later: automated screening

- A low-cost model reads each new post and comment for NSFW content, spam, and off-topic posts.
- It files a report into the same admin queue, marked as automated. It never removes anything or bans anyone by itself, in keeping with the rule that reports do not act automatically.
- **Open before building:** which model, cost per item, and what text and media it is given.
