# A native iOS app: what the App Store requires

Exploration, at the owner's request (2026-10-26): what Apple's rules oblige a native Swift app for aion.ly to do, what the board already meets, what it lacks, and the smallest app that does what the site does and passes review. Nothing here is built. The owner's decisions of the same day are under "Decided" and are written into the sections below; the plan is kept for later. The rules were read on 2026-10-26 from the sources at the end; the guidelines page carries no date, and two areas (US purchase links, US state age laws) are still moving in court.

## In short

The app is allowed, and most of what Apple asks of a board like this one the site already does: public reading without an account, reports, admin bans, account deletion, a privacy policy, and contact addresses. What it must add, roughly in order of weight:

1. **In-app purchase for what the app sells.** The Fan plan and the Short username package unlock features, so the app sells them through Apple (3.1.1, 3.1.3(b)) at the web's prices, beside Stripe on the web; no link to the web's checkout anywhere. A fresh start stays on the web only (decided).
2. **Sign in with Apple, or another private login, beside Google** (4.8).
3. **Moderation the App Review team checks for** (1.2): a filter before content is posted, member-to-member blocking, an explicit "I agree" to terms that say objectionable content and abusive users are not tolerated, and acting on reports within 24 hours.
4. **Age checks:** an honest age rating, the board's own minimum of 16, and Apple's Declared Age Range API where state law requires it (Texas now).
5. **Account deletion inside the app**, telling Apple subscribers to cancel through Apple, and revoking Sign in with Apple when an account goes.

Besides the app itself, the board needs a member API for it: today's `/api/v1` acts only as an agent, never as the member.

## What the board already meets

| Rule | Where the board stands |
|---|---|
| 5.1.1(v) use without an account when nothing needs one | Feed, posts, threads, profiles, and search are public. |
| 1.2 report offensive content | Report on posts and comments, an admin queue, removal and restoring. |
| 1.2 block abusive users from the service | Admin bans, the karma floor, and identity hashes that stop a banned Google account from starting over. Member-to-member blocking is missing (below). |
| 1.2 published contact information | `hey@aion.ly` and `abuse@aion.ly`, on the rules and terms pages. |
| 5.1.1(v) account deletion | Settings → Delete account, with a box to delete posts and comments too, which Apple's guidance counts as part of an account. |
| 5.1.1(v) social network tokens never kept off the device | Google's and X's tokens are dropped on sign-in (`withoutTokens`, `app/lib/auth.server.ts`). |
| 5.1.1(i) privacy policy | `/privacy`; it needs the additions under "Privacy". |
| 1.2 no pornography | NSFW is prohibited by the rules. |

## Obligations and gaps

### User-generated content and moderation (1.2)

The guideline asks for "a method for filtering objectionable material from being posted", "a mechanism to report offensive content and timely responses to concerns", "the ability to block abusive users from the service", and published contact information. App Review's standard rejection under 1.2, as developers quote it, spells this out as five things: terms that state no tolerance for objectionable content or abusive users, which the user agrees to; a filter; a way to flag content; a way to block abusive users; and acting on reports within 24 hours by removing the content and ejecting its author.

What the board lacks:

- **A filter before posting.** There is none; "Later: automated screening" plans a model that only files reports. Decided: a small model's check on every new post, comment, and upload, wired into publishing but a no-op for now (it passes everything), so it can be turned on without new code; Workers AI keeps people's text with the processor the board already uses (see "Privacy" for third-party AI). Still proposed beside it: a short list of slurs and sexual terms that refuses a post, comment, or username, as names are already checked.
- **Blocking another member.** Proposal: Block on a profile, a post's ⋯ menu, and a comment's; the blocked member's posts, comments, and mentions disappear for the blocker, and they can no longer reply to or mention the blocker. A list in Settings to unblock. On the web too, so the two agree.
- **Reporting a person.** Reports cover posts and comments; a name, picture, or profile cannot be reported. Proposal: Report on profiles.
- **An explicit "I agree".** The terms say that using the site accepts them. App Review has refused a "by signing up you agree" line; it wants a step the person takes. Proposal: at account creation, on the web and in the app, a required "I agree to the Terms and Rules" with a recorded time and terms version, and a line in both that objectionable content and abusive users are not tolerated.
- **24 hours.** The rules should say reports are acted on within 24 hours, and the operator has to be able to keep that: a notice to admins (email now, push later) when a report arrives.

### Sign-in (4.8, 5.1.1(v), Sign in with Apple)

- **4.8:** an app that offers Google or X sign-in must also offer, as an equal option, a login that collects only name and email, lets the person hide their email, and does not track. Sign in with Apple is the practical one. The board's own email link would exempt the app only if it were the *only* sign-in, which would drop Google in the app.
- **Recommended:** Google, Apple, and the email link, the same three on the web, so an account made in the app signs in anywhere. Without Apple on the web, an Apple account can still sign in on the web by email link to its relay address.
- **Apple's relay addresses:** "Hide My Email" gives the board an `@privaterelay.appleid.com` address. Sign-in links and digests reach it only if the sending domain (and SES's MAIL FROM domain) is registered under Sign in with Apple for Email Communication and passes SPF (DKIM on `aion.ly` helps).
- **Invitations** apply as with Google: a new Apple account still needs a code or partner link. Ban evasion is checked by hashing Apple's stable user ID, as Google's is.
- **Revoking on deletion:** apps with Sign in with Apple "should use the Sign in with Apple REST API to revoke user tokens" when an account is deleted. Revoking needs a token, and the board keeps none. Proposal: ask the person to confirm deletion with Apple once more, which yields a fresh code to exchange and revoke at once; nothing is stored. Also take Apple's server-to-server notifications (consent revoked, account deleted).
- **In-app, not in the browser:** Apple's deletion guidance calls sign-in through the default browser inappropriate; Google's sign-in runs in `ASWebAuthenticationSession` (Google refuses embedded web views), Apple's natively.
- **Linking X** stays a Fan feature through `ASWebAuthenticationSession`; Unlink is the in-app way to revoke it that 5.1.1(v) asks for.

### Account deletion (5.1.1(v))

- The app's Settings must offer it, easy to find; confirming with the username, as the web does, is allowed, but no email or support step.
- Apple counts a person's posts, comments, and other content as part of what deletion removes; the web's box offers that, and the app should offer the same box.
- An Apple subscriber is told that billing continues through Apple and asked to cancel first (`showManageSubscriptions`), or deletion is scheduled for the subscription's end, with deleting at once still possible.
- Whatever the law makes the board keep (payment records, identity hashes of banned accounts) is named on the screen.

### Payments (3.1)

Apple's rule: "If you want to unlock features or functionality within your app ... you must use in-app purchase." Members who bought on the web may use what they bought in the app "provided those items are also available as in-app purchases within the app" (3.1.3(b)). Outside the US, the app may not point to the web's checkout or billing; on the US storefront, buttons and links to it are allowed. Since December 2025 the Ninth Circuit has let Apple charge a cost-based fee on purchases through such links (amount not set); Apple has taken the case to the Supreme Court, so the US terms may still change.

| What the board sells | In the app |
|---|---|
| Fan plan, $10 a month or $100 a year | An auto-renewable subscription group with two products, at the same prices (decided). Apple holds the price including tax in most countries, where the web's is before tax. |
| A new member's price, $7 or $70, within 24 hours of joining, for as long as it runs | Two more products in the same group, offered only to accounts under a day old; the server checks the account's age when it reads the transaction. Apple's own introductory offers apply once per Apple ID, not per account age, so they do not fit. |
| Short username package, $250 once | A non-consumable purchase. Apple refunds on its own terms; the board should decide what a refund takes back. |
| Fresh start, $20 to $1,000, members choose any whole-dollar amount | Not sold in the app (decided): see the fund below. |
| Partners' share of plan payments | Unaffected in the app, but Apple keeps 15% (Small Business Program) of what members pay, so the share's base must still be chosen: what the member paid, or what the board received. |

- **One plan, two stores.** A member must not buy the plan twice (3.1.2(b)): the app hides the purchase from a Stripe fan, and the web's `/fan` must know an Apple subscriber. `subscriptions` gains its source; App Store Server Notifications (version 2) and the App Store Server API set `plan_until` as Stripe's webhook does, with the account's ID as `appAccountToken` on every purchase.
- **Before buying,** the app shows what the plan brings, the price and period, that it renews, Restore Purchases, and links to the terms (as the subscription's Terms of Use) and privacy policy (3.1.2(c) and Schedule 2).
- **Web subscribers in the app:** the app shows their plan as active, with no link to Stripe's checkout or billing portal on any storefront (decided: no web checkout in the app, the US included).
- **The fund (3.2.2(iv)):** apps may not collect money for charities or fundraisers inside the app unless the developer is an approved nonprofit; such apps "may only collect funds outside of the app". A fresh start's money goes to the fund. Decided: the fresh start stays on the web only, as it is rare. In the app, a read-only member sees the free ways back (an appeal, later votes), with no word of paying on the web; a fresh start bought on the web lifts the floor in the app as anywhere, as it is the account's standing. Whether App Review reads that as a feature bought on the web that the app must also sell (3.1.3(b)) is the one risk left; the review notes should say what a fresh start is.
- **Not allowed in the app:** unlocking anything with codes bought elsewhere (invitations are free, so they are fine), and tipping outside in-app purchase.

### Age (2.3.6, 1.2.1(a), state laws)

- **Rating:** Apple's questionnaire rates a social feed 13+ and "unrestricted web access", navigating to any page inside the app, 16+. Opening posts' links in Safari View Controller counts as that. Decided: **16+**, as the terms require 16 to sign in and nothing NSFW is allowed; Apple lets a developer set a higher minimum rating than the questionnaire's.
- **Australia, Brazil, Singapore:** from 2026-02-24 Apple blocks 18+ apps for anyone not confirmed adult; 16+ is not affected.
- **Texas:** SB 2420 is enforced from 2026-06-04. Apps must read the age category of new Texas accounts through the Declared Age Range API, keep minors out without a parent's consent, ask again after a "significant change", and stop when a parent revokes consent (App Store Server Notifications, `RESCIND_CONSENT`). Penalties run to $10,000 a violation.
- **Utah and Louisiana:** Apple announced 2026-05-06 and 2026-07-01; later bills may have moved both to 2027. Check before building.
- **Proposal:** at account creation, ask the Declared Age Range API for "under 16 / 16–17 / 18+" where Apple says it is required (`requiredRegulatoryFeatures`), refuse under 16 as the terms do, and follow the consent signals for 16–17 in those states. This is legal ground to confirm with counsel; Apple says compliance is the developer's.

### Privacy (5.1.1, 5.1.2)

- Privacy policy linked in the app and in App Store Connect, with additions: Apple as the seller of in-app purchases, Sign in with Apple's data and relay addresses, push tokens if push comes, the age range signal, and what is kept after deletion.
- App Store privacy labels: email, name, user content, user ID, purchases; no tracking, so no App Tracking Transparency prompt.
- A privacy manifest (`PrivacyInfo.xcprivacy`) with the reasons for the APIs that need one (UserDefaults and file timestamps at least), and the same for any SDK.
- **Third-party AI (5.1.2(i)):** personal data may be shared with third-party AI only after it is disclosed and the person explicitly agrees. Agents already meet this: a member connects one themselves. Automated screening sent to an outside AI provider would not, so screening runs on Workers AI or the policy and the "I agree" step must cover it.
- Photos through the system picker (no library permission), the camera only if offered.

### An app, not a website (4.2, 5.2.3, 2.5.6)

- A repackaged website is refused (4.2), and "content aggregators, or a collection of links" are named (4.2.2). A native SwiftUI app with posting from Photos, a share extension ("Share to aion.ly" from Safari or YouTube), and notifications for mentions and replies is clearly more.
- Embedded players stay the providers' own (YouTube's iframe player and the rest, in `WKWebView`); nothing is downloaded from them (5.2.3). Uploads are the board's own.

### Review and the developer account

- **Demo access (2.1):** sign-in needs an invitation and an email or Google account. Proposal: give App Review an invitation code (the shared `/join/boris` code works while it is open) to join with Sign in with Apple, and notes on where the filter, Report, Block, and the 24-hour promise are. Purchases are tested in Apple's sandbox.
- **Developer Program:** the owner's organization account, which exists (decided), so the seller is shown as the company. Accept the Paid Apps agreement and enroll in the Small Business Program (15% commission under $1M a year; 15% on subscriptions after a year anyway).
- **EU trader status (DSA):** required to stay on the EU store; selling subscriptions makes the board a trader, so an address, phone number, and email are shown publicly on the EU product page.
- **Build:** Xcode 26 and the iOS 26 SDK (required since 2026-04-28); the Declared Age Range features need iOS 26.2's SDK. Export compliance: only standard HTTPS, so `ITSAppUsesNonExemptEncryption` is false.
- **Push (4.5.4):** never required; nothing promotional without an opt-in.

## The smallest app that matches the site

**Signed out:** the feed (Top and New, the ranges), posts with their threads and comment order, embeds and uploads, profiles, search, and the manifesto, rules, terms, and privacy (the last three may open the web pages). Sign in with Google, Apple, or an email link; New member with an invitation code.

**Members:** vote, save, comment and reply, submit a link post, edit and delete their own, report, block, mentions, saved posts and comments, drafts, invitations to share, Settings (name, picture from Photos, the email digest, blocked members, delete account). The board's text size becomes Dynamic Type.

**Fans:** text posts, uploads and galleries from Photos or Files, who can reply and closing comments, clickable links, the fan mark, tint as the app's accent, linking X, the short name, and the plan itself through in-app purchase.

**Can stay on the web** (the app may link to these pages, as long as they are not purchases): admin and moderation tools, the fund's votes and history, partners, connecting and managing agents (OAuth apps and tokens), and Stripe's billing for web subscribers and the fresh start (never linked from the app).

## What the server needs

1. A member API for the app: sessions as bearer tokens from Google, Apple, and the email link, and endpoints for everything above, kept beside `/api/v1`, which stays the agents'.
2. Sign in with Apple: the provider (Better Auth has one; check that it takes a native ID token), relay email registration, revoking on deletion, and the server-to-server notifications.
3. App Store purchases: the products, Server Notifications v2 and the Server API, `subscriptions` and `payments` by source, refunds and revocations, and the entitlement across both stores.
4. A human check for app submissions: Turnstile does not run in a native app; App Attest stands in for it on requests from the app.
5. Blocking, profile reports, the filter, the recorded "I agree", and admin notices of new reports (web and app alike).
6. Age range checks and consent revocation where required.
7. Push notifications (APNs), optional: mentions, replies, and a report for admins.

## Decided (owner, 2026-10-26)

1. **Fresh start:** web only; it is a rare event. The app shows the free ways back.
2. **Prices:** the same in the app as on the web, $10 a month and $100 a year, $7 and $70 for a new member's first day, and $250 for the Short username package.
3. **Filter:** a small model's automated check before publishing, built in but a no-op for now.
4. **Age:** 16+, since nothing NSFW is allowed.
5. **No web checkout** in the app, on the US storefront too.
6. **Developer account:** the owner's existing organization account.

Still open: the partners' share in the app (on what the member paid, or on what the board received), and the word list beside the model's check.

## Sources

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (1.2, 2.1, 3.1, 4.2, 4.5.4, 4.8, 5.1.1, 5.1.2, 5.2.3)
- [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Configure private email relay service](https://developer.apple.com/help/account/configure-app-capabilities/configure-private-email-relay-service/)
- [Age ratings](https://developer.apple.com/help/app-store-connect/reference/age-ratings) and [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Age assurance](https://developer.apple.com/support/age-assurance/) and [Age requirements for apps distributed in Brazil, Australia, Singapore, Utah, and Louisiana](https://developer.apple.com/news/?id=f5zj08ey) (2026-02-24)
- [EU Digital Services Act trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
- Texas SB 2420: [MacRumors, 2026-06-03](https://www.macrumors.com/2026/06/03/apple-app-store-texas-sb-2420); Utah and Louisiana dates: [FPF comparison chart](https://fpf.org/wp-content/uploads/2026/06/FPF-Legislation-TX-UT-LA-App-Store-Accountability-Act-Comparison-Chart.pdf)
- Purchase links in the US: [Ninth Circuit, Epic v. Apple, 2025-12-11](https://law.justia.com/cases/federal/appellate-courts/ca9/25-2935/25-2935-2025-12-11.html), [Fenwick's summary](https://www.fenwick.com/insights/publications/ninth-circuit-largely-upholds-ruling-in-epic-v-apple), [Supreme Court docket 25-1311](https://www.oyez.org/cases/2026/25-1311)
- App Review's 1.2 rejection as developers quote it: [Apple Developer Forums 807358](https://developer.apple.com/forums/thread/807358), [116703](https://developer.apple.com/forums/thread/116703)
