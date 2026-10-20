import type { Page } from "@playwright/test";

import { buyName, expect, open, serverSecret, setPlan, test } from "./fixtures";

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
  await expect(page.getByText("No ads, and no data sold")).toBeVisible();
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

test("past the offer's 24 hours, a new member's price waits on the plan page alone, with no time left", async ({ page, context, dayOldAccount }) => {
  await dayOldAccount.signIn(context);
  // Nowhere else offers it any more.
  await open(page, "/settings");
  await expect(page.locator("[data-offer]")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Fan plan" })).toContainText("$10 a month or $100 a year");
  // On the plan page, the price holds for 72 hours, without saying how long.
  await open(page, "/fan");
  const price = page.locator("[data-price]");
  await expect(price.locator("s")).toHaveText("Usually $100");
  await expect(price).toContainText("$70 a year");
  await expect(price.locator("[data-offer]")).toHaveText(/^30% off$/);
});

test("a new member's welcome leads to the plan, with a quiet way on", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/welcome?next=%2Fu%2Fquiet_otter_482");
  // Offers by email are on, with the way to turn them off; nothing to tick.
  await expect(page.getByText(/We.ll email you the new-member offer, 30% off for 24 hours/)).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  // Turned down at once, in one click, as the address is collected.
  await expect(page.getByRole("button", { name: "Continue without them" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/fan\?joined=&next=%2Fu%2Fquiet_otter_482$/);
  await expect(page.getByRole("heading", { name: `Welcome to aion.ly, ${account.username}` })).toBeVisible();
  await expect(page.locator("[data-offer]")).toHaveText(/^30% off\s*2\d hours left$/);
  await page.getByRole("link", { name: "Not now, take me to the board" }).click();
  await expect(page).toHaveURL(/\/u\/quiet_otter_482$/);
  await open(page, "/settings");
  await expect(page.getByRole("region", { name: "Email" })).toContainText("On: a new member's offer");
});

test("a short name typed at the welcome is claimed with the yearly plan", async ({ page, context, account }) => {
  const short = `w${account.id.replace(/\D/g, "").slice(-3).padStart(3, "0")}a`;
  await account.signIn(context);
  await open(page, "/welcome?next=%2F");
  await page.getByLabel("Username").fill(short);
  await expect(page.getByText("Names of 5 characters come with the yearly Fan plan.")).toBeVisible();
  await page.getByRole("button", { name: "Claim it with the yearly plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/fan\\?joined=&name=${short}&next=%2F$`));
  await expect(page.getByRole("heading", { name: `Claim ${short}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
  // Monthly keeps the name it has.
  await page.getByRole("button", { name: "Monthly" }).click();
  const warning = page.getByRole("status").filter({ hasText: `Monthly does not include ${short}.` });
  await expect(warning).toContainText(`with monthly you keep ${account.username}`);
  // The button says what monthly brings, where payments are open.
  const pay = page.locator("[data-price]").locator("xpath=..").getByRole("button").last();
  await expect(pay).toHaveText(new RegExp(`^(Become a fan without ${short}|Payments open soon)$`));
  // One click back to the plan that brings the name.
  await warning.getByRole("button", { name: "Switch to yearly" }).click();
  await expect(page.getByRole("button", { name: "Yearly" })).toHaveAttribute("aria-pressed", "true");
  await expect(pay).toHaveText(new RegExp(`^(Claim ${short} and become a fan|Payments open soon)$`));
  await expect(warning).toHaveCount(0);
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
  // An outside link opens in a new tab, leaving the board where it was.
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(card.getByTitle("aion.ly fan")).toBeVisible();

  // Anywhere in a fan's text: a bare address, and one labelled with itself,
  // are links; a label of other words keeps its address beside it, to copy.
  await page.getByLabel("Comment", { exact: true }).fill(
    "Also see https://example.net/notes in passing, [www.example.org/a](https://example.org/a/), and [a trick](https://example.com/elsewhere).",
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const said = page.locator("li[id^='c-']", { hasText: "in passing" });
  await expect(said.getByRole("link", { name: "example.net/notes" })).toHaveAttribute("href", "https://example.net/notes");
  await expect(said.getByRole("link", { name: "www.example.org/a" })).toHaveAttribute("href", "https://example.org/a/");
  await expect(said.locator("a[href='https://example.com/elsewhere']")).toHaveCount(0);
  await expect(said.getByRole("button", { name: "Copy link https://example.com/elsewhere" })).toBeVisible();

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

test("a fan's tint stands in for orange on every page, from the first paint, in either scheme", async ({ page, context, account, request }) => {
  await account.signIn(context);
  await open(page, "/settings");
  // Without the plan, the tints show but cannot be chosen.
  await expect(page.getByRole("region", { name: "Display" }).getByRole("radio", { name: "Teal" })).toBeDisabled();

  await setPlan(request, account);
  await open(page, "/settings");
  const display = page.getByRole("region", { name: "Display" });
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(await accent()).toBe("#c2410c");
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/settings"));
  await display.getByText("Teal", { exact: true }).click();
  await expect.poll(accent).toBe("#0f766e");
  expect((await saved).status()).toBe(200);
  // Kept on the account, so the server renders it into every page.
  expect(await (await page.request.get("/")).text()).toContain('data-tint="teal"');
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(accent).toBe("#4fd1c5");
  await display.getByText("Orange", { exact: true }).click();
  await expect.poll(accent).toBe("#ff9a5c");
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
  // A tap shows it as large as the screen allows; Escape closes it.
  await page.locator("article").first().getByRole("button", { name: /^See the picture full size/ }).click();
  const large = page.getByRole("dialog", { name: /^A one-pixel masterpiece/ });
  await expect(large.locator("img")).toHaveAttribute("src", /[0-9A-Za-z]{24}\.png$/);
  await page.keyboard.press("Escape");
  await expect(large).toHaveCount(0);
  // The preview of the uploader's own file broke no policy.
  expect(problems.violations).toEqual([]);
});

test("a fan posts a gallery: pictures in an order, swiped through and seen full size", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const file = (name: string) => ({ name, mimeType: "image/png", buffer: PIXEL });
  await page.getByLabel("Upload a file").setInputFiles([file("one.png"), file("two.png"), file("three.png")]);
  await expect(page.getByText("A gallery of 3, the first its cover.")).toBeVisible();
  const order = page.getByRole("list", { name: "Pictures, in order" });
  const sources = () => order.locator("img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  const [a, b] = await sources();
  // The second becomes the cover, and the third goes.
  await order.getByRole("button", { name: "Move picture 2 earlier" }).click();
  await order.getByRole("button", { name: "Remove picture 3" }).click();
  await expect(page.getByText("A gallery of 2, the first its cover.")).toBeVisible();
  expect(await sources()).toEqual([b, a]);
  const keys = JSON.parse(await page.locator("input[name=pictures]").inputValue()).map((picture: { key: string }) => picture.key) as string[];
  expect(keys).toHaveLength(2);
  await page.getByLabel("I made this").check();
  const title = `Two frames by ${account.username}`;
  await finishPost(page, title, "The same prompt, a minute apart, and what changed between them.");

  const gallery = page.getByRole("group", { name: title });
  await expect(gallery.locator("img").first()).toHaveAttribute("src", new RegExp(`${keys[0]}$`));
  await expect(gallery.getByText("1 / 2")).toBeVisible();
  // Swiped, as a finger would.
  await gallery.locator(".snap-x").evaluate((strip) => strip.scrollTo({ left: strip.clientWidth }));
  await expect(gallery.getByText("2 / 2")).toBeVisible();
  // Full size, stepped through with the keyboard.
  await gallery.getByRole("button", { name: /picture 2 of 2$/ }).click();
  const large = page.getByRole("dialog");
  await expect(large.locator("img")).toHaveAttribute("src", new RegExp(`${keys[1]}$`));
  await page.keyboard.press("ArrowLeft");
  await expect(large.locator("img")).toHaveAttribute("src", new RegExp(`${keys[0]}$`));
  await expect(large).toContainText("1 / 2");
  await page.keyboard.press("Escape");
  await expect(large).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("Publish and Save draft wait for every chosen picture to upload (review F88)", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  // The second picture's upload is held until let go.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let sent = 0;
  await page.route(
    (url) => url.pathname === "/submit/upload",
    async (route) => {
      if (route.request().method() === "POST" && ++sent === 2) await held;
      await route.continue();
    },
  );
  const file = (name: string) => ({ name, mimeType: "image/png", buffer: PIXEL });
  await page.getByLabel("Upload a file").setInputFiles([file("one.png"), file("two.png")]);
  await page.getByLabel("I made this").check();
  const title = `Both frames by ${account.username}`;
  await page.getByLabel("Title").fill(title);
  await page.getByRole("textbox", { name: "Description" }).fill("The same prompt, a minute apart, and what changed between them.");
  await page.getByLabel(/made with AI or about AI/).check();
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await expect(page.getByText(/^Uploading 2 of 2/)).toBeVisible();
  await expect(page.getByText("Publish or save once the upload finishes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();

  release();
  await expect(page.getByText("A gallery of 2, the first its cover.")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/[0-9a-z-]+$/);
  await expect(page.getByRole("group", { name: title }).getByText("1 / 2")).toBeVisible();
});

test("a gallery of ten is uploaded and published within one minute (review F89)", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const files = Array.from({ length: 10 }, (_, n) => ({ name: `frame-${n + 1}.png`, mimeType: "image/png", buffer: PIXEL }));
  await page.getByLabel("Upload a file").setInputFiles(files);
  await expect(page.getByText("A gallery of 10, the first its cover.")).toBeVisible();
  await page.getByLabel("I made this").check();
  const title = `Ten frames by ${account.username}`;
  await finishPost(page, title, "One prompt run ten times, a minute apart, in the order they came.");
  const gallery = page.getByRole("group", { name: title });
  await expect(gallery.getByText("1 / 10")).toBeVisible();
  // Only the picture in view and the next are asked for; stepping on asks for one more (review F90).
  const requested = () =>
    page.evaluate(() => new Set(performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/[0-9A-Za-z]{24}\.png$/.test(name))).size);
  await expect(gallery.locator("img")).toHaveCount(2);
  await gallery.locator(".snap-x").evaluate((strip) => strip.scrollTo({ left: strip.clientWidth }));
  await expect(gallery.getByText("2 / 10")).toBeVisible();
  await expect(gallery.locator("img")).toHaveCount(3);
  expect(await requested()).toBeLessThanOrEqual(3);
});

test("a file dropped on the upload area is uploaded, and one dropped beside it opens nothing", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const transfer = await page.evaluateHandle((bytes) => {
    const files = new DataTransfer();
    files.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
    return files;
  }, [...PIXEL]);
  // Beside it, the browser's own handling, opening the file in place of the form, is held back.
  const prevented = await page.evaluate((files) => {
    const drop = new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true });
    document.body.dispatchEvent(drop);
    return drop.defaultPrevented;
  }, transfer);
  expect(prevented).toBe(true);
  await expect(page).toHaveURL(/\/submit$/);
  const area = page.getByRole("button", { name: /^Choose or drop pictures/ });
  await area.dispatchEvent("dragenter", { dataTransfer: transfer });
  await area.dispatchEvent("dragover", { dataTransfer: transfer });
  await area.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByText(/^Uploaded/)).toBeVisible();
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
    page.getByRole("menuitemradio", { name: "Weekly and monthly" }).click(),
  ]);
  await open(page, "/");
  await expect(page.getByRole("button", { name: "Email digest: Weekly and monthly" })).toBeVisible();

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
  await expect(page.getByRole("button", { name: "Email digest: Weekly and monthly" })).toBeVisible();
  // Offers are on until the member turns them off, and on again whenever they say.
  await expect(email).toContainText("On: a new member's offer");
  await email.getByRole("button", { name: "Turn off" }).click();
  await expect(email).toContainText(/Off since .+\. Turn it on for a new member's offer/);
  await email.getByRole("button", { name: "Turn on" }).click();
  await expect(email).toContainText("On: a new member's offer");

  // A mail client's one click, with the signed token alone.
  const token = encodeURIComponent(await unsubscribeToken(account.id));
  const oneClick = await request.post(`/unsubscribe?list=offers&token=${token}`, { form: { "List-Unsubscribe": "One-Click" } });
  expect(oneClick.status()).toBe(200);
  await open(page, "/settings");
  await expect(email).toContainText(/Off since .+\. Turn it on for a new member's offer/);
  // The digest stays as it was.
  await expect(email.getByLabel("Digest of top posts")).toHaveValue("weekly");
  // As the next run finds it.
  await email.getByRole("button", { name: "Turn on" }).click();
  await expect(email).toContainText("On: a new member's offer");
});

test("a fan connects an agent, which pauses when the plan ends", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("radio", { name: /Post & comment/ }).check();
  await section.getByRole("button", { name: "New token" }).click();
  const token = (await section.locator("code", { hasText: /^aionly_/ }).textContent())!.trim();
  const auth = { Authorization: `Bearer ${token}` };

  const created = await request.post("/api/v1/posts", {
    headers: auth,
    data: { kind: "text", title: "Notes from the agent", description: "A text post written through the agent API.", replies: "closed" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id: closedPost } = await created.json();

  await setPlan(request, account, "canceled");
  // Paused, the agent can do nothing at all, reading included, until the plan is back.
  // A read follows each refused write: locally, a write refused before its
  // body is read can break the next request on its connection, and only
  // reads are tried again (see e2e/support/preview-fixes.cjs).
  for (const answer of [
    await request.patch(`/api/v1/posts/${closedPost}`, { headers: auth, data: { replies: "all" } }),
    await request.get("/api/v1/me", { headers: auth }),
    await request.post("/api/v1/posts", { headers: auth, data: { kind: "text", title: "Another note", description: "This one should not go out at all." } }),
    await request.get(`/api/v1/posts/${closedPost}`, { headers: auth }),
  ]) {
    expect(answer.status()).toBe(403);
    expect((await answer.json()).error).toBe("paused");
  }
  await open(page, "/settings");
  const pausedSection = page.getByRole("region", { name: "Your agent" });
  await expect(pausedSection).toContainText("is paused");
  // Its token stays listed, and can still be reined in without the plan, but not given more.
  await expect(pausedSection.getByRole("button", { name: "New token" })).toHaveCount(0);
  const permission = pausedSection.getByRole("combobox", { name: /may do/ });
  await permission.selectOption("read_only");
  await expect(permission).toHaveValue("read_only");
  await expect(permission.locator("option[value=read_write]")).toBeDisabled();
  await pausedSection.getByRole("button", { name: "Revoke" }).click();
  await expect(pausedSection.getByText("No apps or tokens yet.")).toBeVisible();
  expect((await request.get("/api/v1/me", { headers: auth })).status()).toBe(401);
});

test("a fan's agent uploads a video through the API and posts it", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("radio", { name: /Post & comment/ }).check();
  await section.getByRole("button", { name: "New token" }).click();
  const auth = { Authorization: `Bearer ${(await section.locator("code", { hasText: /^aionly_/ }).textContent())!.trim()}` };

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

  // Who may reply to their comments, everywhere, is set once in Settings,
  // and what new posts start with, beside it.
  await open(page, "/settings");
  const replies = page.getByRole("region", { name: "Replies", exact: true });
  await replies.getByLabel("Who can reply to your comments").selectOption("humans");
  await replies.getByLabel("Who can comment on your posts").selectOption("humans_good_agents");
  await replies.getByRole("button", { name: "Save" }).click();
  await expect(replies.getByText("Saved.")).toBeVisible();
  await open(page, "/settings");
  await expect(page.getByLabel("Who can reply to your comments")).toHaveValue("humans");
  await expect(page.getByLabel("Who can comment on your posts")).toHaveValue("humans_good_agents");
  // A new post starts with it, and may still choose another.
  await open(page, "/submit");
  await expect(page.getByLabel("Who can comment")).toHaveValue("humans_good_agents");
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

test("a name of 4 characters comes with the 4-letter username, bought once, with or without the plan", async ({ page, context, account, request }) => {
  const four = `k${account.id.replace(/\D/g, "").slice(-3).padStart(3, "0")}`;
  await account.signIn(context);
  await open(page, "/settings");
  await page.getByLabel("Username").fill(four);
  const note = page.getByText(/Names of 4 characters need the 4-letter username add-on, bought once apart from the Fan plan: \$250 plus VAT\./);
  await expect(note).toBeVisible();
  // Right under the field, in the line kept for its messages.
  const field = (await page.getByLabel("Username").boundingBox())!;
  expect((await note.boundingBox())!.y - (field.y + field.height)).toBeLessThan(12);
  await page.getByRole("button", { name: "Get the 4-letter username add-on" }).click();
  await expect(page).toHaveURL(new RegExp(`/fan\\?name=${four}&next=%2Fsettings$`));
  await expect(page.getByRole("heading", { name: `Claim ${four}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The 4-letter username add-on" })).toBeVisible();
  await expect(page.getByText("$250 once")).toBeVisible();
  // The name alone, or with the plan; the box asks for it at once, without a refund.
  const pay = page.getByRole("button", { name: /^(Claim .+|Payments open soon)$/ });
  await expect(pay).toHaveText(new RegExp(`^(Claim ${four} for \\$250|Payments open soon)$`));
  await page.getByRole("button", { name: "+ Yearly" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(pay).toHaveText(new RegExp(`^(Claim ${four} and become a fan|Payments open soon)$`));
  await expect(page.getByRole("checkbox", { name: /cannot be withdrawn or refunded/ })).toBeVisible();

  // Bought, as Stripe reports it: the name is the member's to take, with no plan.
  await buyName(request, account);
  await open(page, "/settings");
  await page.getByLabel("Username").fill(four);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText(`Your name is now ${four}.`)).toBeVisible();
  await expect(page.getByLabel("Username")).toHaveValue(four);
});

test("a plan set to end says what stops then, and that a short name is no longer certain", async ({ page, context, account, request }) => {
  const short = `e${account.id.replace(/\D/g, "").slice(-3).padStart(3, "0")}a`;
  await setPlan(request, account, "active", "year");
  await account.signIn(context);
  await open(page, "/settings");
  await page.getByLabel("Username").fill(short);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText(`Your name is now ${short}.`)).toBeVisible();
  await setPlan(request, account, "active", "year", true);
  await open(page, "/settings");
  const plan = page.getByRole("region", { name: "Fan plan" });
  await expect(plan).toContainText("ending on");
  await expect(plan.getByRole("status")).toContainText("From then on, your agent pauses");
  await expect(plan.getByRole("status")).toContainText(`Your username, ${short}, stays yours, but no longer for certain`);
  // Ended, the name stays, and its hint says it is no longer certain.
  await setPlan(request, account, "canceled", "year");
  await open(page, "/settings");
  await expect(page.getByLabel("Username")).toHaveValue(short);
  await expect(page.getByText(/no longer for certain/).first()).toBeVisible();
});

test("a name of 5 characters comes with the yearly plan", async ({ page, context, account, request }) => {
  const short = `q${account.id.replace(/\D/g, "").slice(-3).padStart(3, "0")}a`;
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
