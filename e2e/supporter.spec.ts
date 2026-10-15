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

test("the plan page shows what supporters get, picks out what was asked for, and its prices", async ({ page, context, account }) => {
  await open(page, "/supporter");
  await expect(page.getByRole("heading", { name: "Support aion.ly" })).toBeVisible();
  await expect(page.getByText("aion.ly has no ads")).toBeVisible();
  await expect(page.getByRole("button", { name: "$7 a month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "$70 a year" })).toBeVisible();
  await expect(page.getByText("plus VAT or sales tax where it applies").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to support" })).toBeVisible();

  await open(page, "/supporter?for=upload");
  await expect(page.getByRole("heading", { name: "Uploads are for supporters" })).toBeVisible();
  await expect(page.locator("[data-highlight]")).toContainText("Uploads");

  // Locally there is no Stripe key, so checkout is closed and says so.
  await account.signIn(context);
  await open(page, "/supporter");
  await expect(page.getByRole("button", { name: "Payments open soon" })).toBeDisabled();
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

test("a supporter writes a text post, with the Supporter mark and a clickable link", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  await expect(page.getByRole("region", { name: "Supporter plan" })).toContainText("Thank you for supporting the board.");

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
  await expect(card.getByTitle("Supporter")).toBeVisible();

  // Hidden in Settings, the mark goes.
  await open(page, "/settings");
  await page.getByRole("button", { name: "Hide it" }).click();
  await expect(page.getByText("The Supporter mark is hidden beside your name.")).toBeVisible();
  await open(page, `/u/${account.username}`);
  await expect(page.getByTitle("Supporter")).toHaveCount(0);
});

test("a supporter uploads a picture and posts it", async ({ page, context, account, request, problems }) => {
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

test("a supporter turns the digest on from the top bar, and its link unsubscribes without signing in", async ({ page, context, account, request, browser }) => {
  await setPlan(request, account);
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

test("a supporter connects an agent, which pauses when the plan ends", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("button", { name: "New token" }).click();
  const token = (await section.locator("code").textContent())!.trim();
  const auth = { Authorization: `Bearer ${token}` };

  const created = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "text", title: "Notes from the agent", description: "A text post written through the agent API." },
  });
  expect(created.status(), await created.text()).toBe(201);

  await setPlan(request, account, "canceled");
  expect((await (await request.get("/api/v1/me", { headers: auth })).json()).paused).toBe(true);
  const paused = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "text", title: "Another note", description: "This one should not go out at all." },
  });
  expect(paused.status()).toBe(403);
  await open(page, "/settings");
  await expect(page.getByRole("region", { name: "Your agent" })).toContainText("is paused");
});

test("a supporter's agent uploads a video through the API and posts it", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
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
