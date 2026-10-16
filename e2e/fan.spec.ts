import type { Page } from "@playwright/test";

import { expect, open, serverSecret, setPlan, test } from "./fixtures";

// A PNG of one pixel.
const PIXEL = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d4944415478da63f80f0000010101001bb6ee560000000049454e44ae426082",
  "hex",
);

// The start of an MP4 file: enough for the server, which reads the type from the bytes.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);

async function finishPost(page: Page, title: string, body: string): Promise<void> {
  await page.getByLabel("Title").fill(title);
  await page.getByRole("textbox", { name: /^(Text|Description)$/ }).fill(body);
  await page.getByLabel(/made with AI or about AI/).check();
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/[0-9a-z-]+$/);
}

/** The unsubscribe token the server signs, made the same way. */
async function unsubscribeToken(userId: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(serverSecret("BETTER_AUTH_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, enc.encode("aionly digest unsubscribe v1"));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(userId)));
  return `${userId}.${Buffer.from(mac.subarray(0, 18)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

test("the plan page shows what fans get, picks out what was asked for, and its prices", async ({ page, context, account }) => {
  await open(page, "/fan");
  await expect(page.getByRole("heading", { name: "Become an aion.ly fan" })).toBeVisible();
  await expect(page.getByText("aion.ly has no ads")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-price]")).toContainText("$100 a year");
  await page.getByRole("button", { name: "Monthly" }).click();
  await expect(page.locator("[data-price]")).toContainText("$10 a month");
  await expect(page.getByText("New members get 30% off in their first 24 hours.")).toBeVisible();
  await expect(page.getByText("plus VAT or sales tax where it applies").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to become a fan" })).toBeVisible();

  // The plan's old address, from before it was the Fan plan, leads here.
  await open(page, "/supporter?for=upload");
  await expect(page).toHaveURL(/\/fan\?for=upload$/);
  await expect(page.getByRole("heading", { name: "Uploads are for fans" })).toBeVisible();
  await expect(page.locator("[data-highlight]")).toContainText("Uploads");

  // Locally there is no Stripe key, so checkout is closed and says so.
  await account.signIn(context);
  await open(page, "/fan");
  await expect(page.getByRole("button", { name: "Payments open soon" })).toBeDisabled();
  // The account was made an hour ago: a new member's prices, 30% off, the
  // plan's own struck through, with the hours left and no ticking clock.
  const price = page.locator("[data-price]");
  await expect(price.locator("s")).toHaveText("Usually $100");
  await expect(price).toContainText("$70 a year");
  await expect(price.locator("[data-offer]")).toHaveText(/^30% off\s*2\d hours left$/);
  await page.getByRole("button", { name: "Monthly" }).click();
  await expect(price.locator("s")).toHaveText("Usually $10");
  await expect(price).toContainText("$7 a month");
  await expect(page.getByText(/\d+:\d\d:\d\d/)).toHaveCount(0);
  // Nothing to tick: starting the plan is the request for it to start at once.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("Your plan starts as soon as you pay, through Stripe.")).toBeVisible();
});

test("a new member's welcome leads to the plan, with a quiet way on", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/welcome?next=%2Fu%2Fquiet_otter_482");
  // Offers by email only with the member's own yes, unticked to start.
  const offers = page.getByRole("checkbox", { name: /Email me the new-member offer/ });
  await expect(offers).not.toBeChecked();
  await offers.check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/fan\?joined=&next=%2Fu%2Fquiet_otter_482$/);
  await expect(page.getByRole("heading", { name: `Welcome to aion.ly, ${account.username}` })).toBeVisible();
  await expect(page.locator("[data-offer]")).toHaveText(/^30% off\s*2\d hours left$/);
  await page.getByRole("link", { name: "Not now, take me to the board" }).click();
  await expect(page).toHaveURL(/\/u\/quiet_otter_482$/);
  await open(page, "/settings");
  await expect(page.getByRole("region", { name: "Email" })).toContainText(/On since .+: a new member's offer/);
});

test("a short name typed at the welcome is claimed with the yearly plan", async ({ page, context, account }) => {
  const short = `w${account.id.replace(/\D/g, "").slice(-3)}a`;
  await account.signIn(context);
  await open(page, "/welcome?next=%2F");
  await page.getByLabel("Username").fill(short);
  await expect(page.getByText("Names of 4 or 5 characters come with the yearly Fan plan.")).toBeVisible();
  await page.getByRole("button", { name: "Claim it with the yearly plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/fan\\?joined=&name=${short}&next=%2F$`));
  await expect(page.getByRole("heading", { name: `Claim ${short}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
  // Monthly keeps the name it has.
  await page.getByRole("button", { name: "Monthly" }).click();
  await expect(page.getByText(`with monthly you keep ${account.username}`)).toBeVisible();
  await page.getByRole("link", { name: `Not now; keep ${account.username}` }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: `Account: ${account.username}` })).toBeVisible();
});

test("Stripe's webhook refuses an unsigned or wrongly signed event", async ({ request }) => {
  const event = JSON.stringify({ type: "customer.subscription.created", created: 0, data: { object: {} } });
  const unsigned = await request.post("/api/stripe", { headers: { "Content-Type": "application/json" }, data: event });
  expect(unsigned.status()).toBe(400);
  const forged = await request.post("/api/stripe", {
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    data: event,
  });
  expect(forged.status()).toBe(400);
});

test("a fan writes a text post, with the fan mark and a clickable link", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  await expect(page.getByRole("region", { name: "Fan plan" })).toContainText("Thank you for being a fan.");

  await open(page, "/submit");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  // A text post is the author's own: no made or found.
  await expect(page.getByLabel("I made this")).toBeHidden();
  const title = `A prompt from ${account.username}`;
  await finishPost(page, title, "Here is the prompt I use, and the page it came from:\n\nhttps://example.com/the-prompt-guide\n\nIt works well.");

  const card = page.locator("article").first();
  // No outside link: the title leads to the post itself.
  await expect(card.locator("h2 a")).toHaveAttribute("href", /^\/p\/[0-9a-z]{7}\//);
  const link = card.getByRole("link", { name: "example.com/the-prompt-guide" });
  await expect(link).toHaveAttribute("href", "https://example.com/the-prompt-guide");
  await expect(link).toHaveAttribute("rel", "nofollow ugc noopener");
  await expect(card.getByTitle("aion.ly fan")).toBeVisible();

  // In the feed, the excerpt keeps the post's lines.
  await open(page, "/?sort=new&range=all");
  const inFeed = page.locator("article").filter({ has: page.getByRole("link", { name: title }) });
  expect(await inFeed.locator("p.whitespace-pre-line").innerText()).toBe(
    "Here is the prompt I use, and the page it came from:\nhttps://example.com/the-prompt-guide\nIt works well.",
  );

  // Hidden in Settings, the mark goes.
  await open(page, "/settings");
  await page.getByRole("button", { name: "Hide it" }).click();
  await expect(page.getByText("The fan mark is hidden beside your name.")).toBeVisible();
  await open(page, `/u/${account.username}`);
  await expect(page.getByTitle("aion.ly fan")).toHaveCount(0);
});

test("a fan uploads a picture and posts it", async ({ page, context, account, request, problems }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByLabel("Upload a file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PIXEL });
  await expect(page.getByText(/^Uploaded/)).toBeVisible();
  await page.getByLabel("I made this").check();
  await finishPost(page, `A one-pixel masterpiece by ${account.username}`, "Generated at the smallest size the model allows.");

  const picture = page.locator("article").first().locator("img[alt^='A one-pixel masterpiece']");
  await expect(picture).toHaveAttribute("src", /[0-9A-Za-z]{24}\.png$/);
  // The preview of the uploader's own file broke no policy.
  expect(problems.violations).toEqual([]);
});

test("uploads refuse what is not a picture, video, or audio", async ({ page, context, account, request, baseURL }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByLabel("Upload a file").setInputFiles({ name: "page.png", mimeType: "image/png", buffer: Buffer.from("<!doctype html>") });
  await expect(page.getByRole("alert").filter({ hasText: "Upload a JPEG, PNG" })).toBeVisible();
  // Once the plan ends, nothing more can be uploaded.
  const upload = { method: "POST", headers: { "Content-Type": "image/png", Origin: new URL(baseURL!).origin }, data: PIXEL };
  const allowed = await page.request.fetch("/submit/upload", upload);
  expect(allowed.status()).toBe(200);
  await setPlan(request, account, "canceled");
  const refused = await page.request.fetch("/submit/upload", upload);
  expect(refused.status()).toBe(403);
});

test("any member turns the digest on from the top bar, and its link unsubscribes without signing in", async ({ page, context, account, request, browser }) => {
  // Free: no plan needed.
  await account.signIn(context);
  await open(page, "/");
  await page.getByRole("button", { name: "Email digest: Off" }).click();
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/digest")),
    page.getByRole("menuitemradio", { name: "Weekly" }).click(),
  ]);
  await open(page, "/");
  await expect(page.getByRole("button", { name: "Email digest: Weekly" })).toBeVisible();

  // The address in the email, opened in a browser that is not signed in.
  const stranger = await browser.newPage();
  await stranger.goto(`/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(account.id))}`);
  await stranger.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(stranger.getByText("You are unsubscribed.")).toBeVisible();
  await stranger.close();

  await open(page, "/");
  await expect(page.getByRole("button", { name: "Email digest: Off" })).toBeVisible();
});

test("a mail client's one-click unsubscribe needs only the signed token", async ({ request, account }) => {
  const token = encodeURIComponent(await unsubscribeToken(account.id));
  const oneClick = await request.post(`/digest/unsubscribe?token=${token}`, { form: { "List-Unsubscribe": "One-Click" } });
  expect(oneClick.status()).toBe(200);
  const forged = await request.get(`/digest/unsubscribe?token=${encodeURIComponent(`${account.id}.forged`)}`);
  expect(await forged.text()).toContain("This unsubscribe link is not valid.");
});

test("Settings chooses the emails, and an offer's one-click link turns offers off", async ({ page, context, account, request }) => {
  await account.signIn(context);
  await open(page, "/settings#email");
  const email = page.getByRole("region", { name: "Email" });
  // The digest, free, from here as from the top bar.
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/digest")),
    email.getByLabel("Digest of top posts").selectOption("weekly"),
  ]);
  await expect(page.getByRole("button", { name: "Email digest: Weekly" })).toBeVisible();
  // Offers are off until the member says yes, and off again whenever they say.
  await expect(email).toContainText("Off. Turn it on for a new member's offer");
  await email.getByRole("button", { name: "Turn on" }).click();
  await expect(email).toContainText(/On since .+: a new member's offer/);
  await email.getByRole("button", { name: "Turn off" }).click();
  await expect(email).toContainText("Off. Turn it on for a new member's offer");
  await email.getByRole("button", { name: "Turn on" }).click();
  await expect(email).toContainText(/On since/);

  // A mail client's one click, with the signed token alone.
  const token = encodeURIComponent(await unsubscribeToken(account.id));
  const oneClick = await request.post(`/unsubscribe?list=offers&token=${token}`, { form: { "List-Unsubscribe": "One-Click" } });
  expect(oneClick.status()).toBe(200);
  await open(page, "/settings");
  await expect(email).toContainText("Off. Turn it on for a new member's offer");
  // The digest stays as it was.
  await expect(email.getByLabel("Digest of top posts")).toHaveValue("weekly");
});

test("a fan connects an agent, which pauses when the plan ends", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("checkbox", { name: /Let it post and comment/ }).check();
  await section.getByRole("button", { name: "New token" }).click();
  const token = (await section.locator("code").textContent())!.trim();
  const auth = { Authorization: `Bearer ${token}` };

  const created = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "text", title: "Notes from the agent", description: "A text post written through the agent API.", replies: "closed" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id: closedPost } = await created.json();

  await setPlan(request, account, "canceled");
  // Paused, the agent may still open its own closed discussion, and nothing else.
  expect((await request.patch(`/api/v1/posts/${closedPost}`, { headers: auth, data: { title: "Renamed" } })).status()).toBe(403);
  const reopened = await request.patch(`/api/v1/posts/${closedPost}`, { headers: auth, data: { replies: "all" } });
  expect(reopened.status(), await reopened.text()).toBe(200);
  expect((await (await request.get(`/api/v1/posts/${closedPost}`, { headers: auth })).json()).comments_closed).toBeUndefined();
  expect((await request.patch(`/api/v1/posts/${closedPost}`, { headers: auth, data: { replies: "closed" } })).status()).toBe(403);
  expect((await (await request.get("/api/v1/me", { headers: auth })).json()).paused).toBe(true);
  const paused = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "text", title: "Another note", description: "This one should not go out at all." },
  });
  expect(paused.status()).toBe(403);
  await open(page, "/settings");
  const pausedSection = page.getByRole("region", { name: "Your agent" });
  await expect(pausedSection).toContainText("is paused");
  // Its token still reads, so it stays listed, and can still be reined in without the plan.
  await expect(pausedSection.getByRole("button", { name: "New token" })).toHaveCount(0);
  await pausedSection.getByRole("button", { name: "Make read-only" }).click();
  await expect(pausedSection.getByText("Reads only")).toBeVisible();
  await expect(pausedSection.getByRole("button", { name: "Allow posting" })).toHaveCount(0);
  await pausedSection.getByRole("button", { name: "Revoke" }).click();
  await expect(pausedSection.getByText("No apps or tokens.")).toBeVisible();
  expect((await request.get("/api/v1/me", { headers: auth })).status()).toBe(401);
});

test("a fan's agent uploads a video through the API and posts it", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("checkbox", { name: /Let it post and comment/ }).check();
  await section.getByRole("button", { name: "New token" }).click();
  const auth = { Authorization: `Bearer ${(await section.locator("code").textContent())!.trim()}` };

  const notMedia = await request.post("/api/v1/uploads", { headers: { ...auth, "Content-Type": "text/html" }, data: "<!doctype html>" });
  expect(notMedia.status()).toBe(415);
  const uploaded = await request.post("/api/v1/uploads", { headers: { ...auth, "Content-Type": "video/mp4" }, data: MP4 });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const { upload, type } = await uploaded.json();
  expect(type).toBe("video");

  const created = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "upload", upload, title: "Rain on a street that never was", description: "A clip generated from one prompt, with no edits.", width: 1920, height: 1080, duration: 12 },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  const read = await (await request.get(`/api/v1/posts/${id}`, { headers: auth })).json();
  expect(read).toMatchObject({ kind: "upload", link: null, file: { type: "video" } });

  await open(page, `/p/${id}`);
  const card = page.locator("article").first();
  // Its poster, or the player once it takes focus.
  await expect(card.getByRole("button", { name: "Play video" }).or(card.locator("video"))).toBeVisible();
});

test("deleting the account signs out, and what it wrote can go with it", async ({ page, context, account }) => {
  await account.signIn(context);
  // A comment to delete along with the account.
  await open(page, "/p/s_post_02");
  const text = `A comment by ${account.username} that goes with the account.`;
  await page.getByLabel("Comment", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText(text)).toBeVisible();

  await open(page, "/settings");
  const button = page.getByRole("button", { name: "Delete account" });
  await expect(button).toBeDisabled();
  await page.getByLabel("Also delete my posts and comments").check();
  await page.getByLabel(/Type .* to confirm/).fill(account.username);
  await button.click();
  await expect(page).toHaveURL(/\/deleted$/);
  await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: "Sign in" })).toBeVisible();

  await open(page, "/p/s_post_02");
  await expect(page.getByText(text)).toHaveCount(0);
  expect((await page.request.get(`/u/${account.username}`)).status()).toBe(404);
});

test("a fan chooses who can comment on a post and who can reply to them", async ({ page, context, account, otherAccount, request, baseURL }) => {
  // Without the plan, the choice leads to the plan.
  await account.signIn(context);
  await open(page, "/submit");
  await expect(page.getByText("Who can comment: everyone.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Choosing comes with the Fan plan" })).toHaveAttribute("href", "/fan?for=replies");

  await setPlan(request, account);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Who can comment").selectOption("agents");
  await finishPost(page, `Only agents may comment ${account.username}`, "A post that only agents may comment on, to try the choice.");
  const postPath = new URL(page.url()).pathname;
  // Its author may still comment, and sees the rule.
  await expect(page.getByText("Only agents can comment on this post.")).toBeVisible();
  await expect(page.getByLabel("Comment", { exact: true })).toBeVisible();

  // Another member sees the rule in place of the box, and the server agrees.
  const other = await context.browser()!.newContext();
  await otherAccount.signIn(other);
  const otherPage = await other.newPage();
  await open(otherPage, postPath);
  await expect(otherPage.getByText("Only agents can comment on this post.")).toBeVisible();
  await expect(otherPage.getByLabel("Comment", { exact: true })).toHaveCount(0);
  const refused = await otherPage.request.post(postPath, { form: { intent: "comment", body: "Let me in." }, headers: { Origin: baseURL! } });
  expect(refused.status()).toBe(403);

  // The author opens it to everyone again from the edit page.
  await open(page, `/p/${postPath.split("/")[2]}/edit`);
  await page.getByLabel("Who can comment").selectOption("all");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`${postPath}$`));
  await expect(page.getByText("Only agents can comment on this post.")).toHaveCount(0);
  await open(otherPage, postPath);
  await expect(otherPage.getByLabel("Comment", { exact: true })).toBeVisible();
  await other.close();

  // Who may reply to their comments, everywhere, is set once in Settings.
  await open(page, "/settings");
  const replies = page.getByRole("region", { name: "Replies to your comments" });
  await replies.getByLabel("Who can reply to your comments").selectOption("humans");
  await replies.getByRole("button", { name: "Save" }).click();
  await expect(replies.getByText("Saved.")).toBeVisible();
  await open(page, "/settings");
  await expect(page.getByLabel("Who can reply to your comments")).toHaveValue("humans");
});

test("a fan closes a post's comments to everyone, and opens them again after the plan ends", async ({ page, context, account, otherAccount, request, baseURL }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Who can comment").selectOption("closed");
  await finishPost(page, `Closed to comments ${account.username}`, "A post whose comments are closed from the start.");
  const postPath = new URL(page.url()).pathname;
  // Not even its author comments; the reason shows in place of the box.
  await expect(page.getByText("Comments are closed.")).toBeVisible();
  await expect(page.getByLabel("Comment", { exact: true })).toHaveCount(0);
  const refused = await page.request.post(postPath, { form: { intent: "comment", body: "Let me in." }, headers: { Origin: baseURL! } });
  expect(refused.status()).toBe(403);
  expect((await page.request.get(`${postPath}.md`)).ok()).toBe(true);
  expect(await (await page.request.get(`${postPath}.md`)).text()).toContain("- Comments are closed.");

  const other = await context.browser()!.newContext();
  await otherAccount.signIn(other);
  const otherPage = await other.newPage();
  await open(otherPage, postPath);
  await expect(otherPage.getByText("Comments are closed.")).toBeVisible();
  await expect(otherPage.getByLabel("Comment", { exact: true })).toHaveCount(0);

  // The plan ends; the comments stay closed until the author opens them.
  await setPlan(request, account, "canceled");
  await open(page, `/p/${postPath.split("/")[2]}/edit`);
  await page.getByLabel("Its comments are closed. Open them again to everyone.").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`${postPath}$`));
  await expect(page.getByText("Comments are closed.")).toHaveCount(0);
  await open(otherPage, postPath);
  await expect(otherPage.getByLabel("Comment", { exact: true })).toBeVisible();
  await other.close();
});

test("an account with a running plan is not deleted while Stripe cannot cancel it", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  await page.getByLabel(/Type .* to confirm/).fill(account.username);
  await page.getByRole("button", { name: "Delete account" }).click();
  // Locally there is no Stripe key, so the plan cannot be cancelled, and nothing goes.
  await expect(page.getByText("Your plan could not be cancelled just now, so nothing was deleted.")).toBeVisible();
  expect((await page.request.get(`/u/${account.username}`)).status()).toBe(200);
});

test("a name of 4 or 5 characters comes with the yearly plan", async ({ page, context, account, request }) => {
  const short = `q${account.id.replace(/\D/g, "").slice(-3)}a`;
  await account.signIn(context);
  await open(page, "/settings");
  const name = page.getByLabel("Username");
  await name.fill(short);
  // Offered with the yearly plan, on the plan's page.
  await page.getByRole("button", { name: "Claim it with the yearly plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/fan\\?name=${short}&next=%2Fsettings$`));
  await expect(page.getByRole("heading", { name: `Claim ${short}` })).toBeVisible();

  // A monthly plan is not enough.
  await setPlan(request, account);
  await open(page, "/settings");
  await page.getByLabel("Username").fill(short);
  await expect(page.getByRole("button", { name: "Claim it with the yearly plan" })).toBeVisible();

  await setPlan(request, account, "active", "year");
  await open(page, "/settings");
  await page.getByLabel("Username").fill(short);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText(`Your name is now ${short}.`)).toBeVisible();
  // Brand names stay reserved, plan or not.
  await expect(page.getByLabel("Username")).toHaveValue(short);
});
