import { expect, open, test } from "./fixtures";

const noSideScroll = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;

test("the fund says where fresh starts' money goes, open to everyone", async ({ page }) => {
  await open(page, "/fund");
  await expect(page.getByRole("heading", { name: "The fund", level: 1 })).toBeVisible();
  await expect(page.getByText(/We keep none of it/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "The next gift" })).toBeVisible();
  await expect(page.getByRole("link", { name: "fresh start" })).toHaveAttribute("href", "/fresh-start");
  expect(await page.evaluate(noSideScroll)).toBeLessThanOrEqual(0);
});

test("the partners' page gives the offer with the board's numbers", async ({ page }) => {
  await open(page, "/partners");
  await expect(page.getByRole("heading", { name: "Be aion.ly's guest editor", level: 1 })).toBeVisible();
  await expect(page.getByText("half of what they pay for the Fan plan in their first year")).toBeVisible();
  await expect(page.getByText("Moderation stays with the board's admins")).toBeVisible();
  await expect(page.getByRole("link", { name: "hey@aion.ly" })).toHaveAttribute("href", /^mailto:hey@aion\.ly/);
  expect(await page.evaluate(noSideScroll)).toBeLessThanOrEqual(0);
});

test("a partner link that does not exist says so", async ({ page }) => {
  const response = await page.goto("/join/no-such-link");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("There is no link like this.")).toBeVisible();
});

test("an admin makes a partner link that shares in steps and gives no free invitations", async ({ page, context, adminAccount }, testInfo) => {
  const code = `steps-${testInfo.project.name}`;
  await adminAccount.signIn(context);
  await open(page, "/admin/partners");
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Make a link" }) });
  await form.getByLabel("Partner's username").fill("e2e_admin");
  await form.getByLabel("Link name").fill(code);
  await form.getByLabel("First, %").fill("100");
  await form.getByLabel("For months").first().fill("12");
  await form.getByLabel("Then, %").first().fill("50");
  // The row's inputs line up, wherever a label wraps.
  const top = async (label: string) => (await form.getByLabel(label).boundingBox())!.y;
  expect(await top("Accounts")).toBe(await top("Free invitations each"));
  await form.getByRole("button", { name: "Make the link" }).click();
  await expect(page.getByText(`Made /join/${code}.`)).toBeVisible();
  const item = page.getByRole("listitem").filter({ hasText: `/join/${code}` });
  await expect(item).toContainText("100% for 12 months, then 50% for good · 0 free invitations each");
  // Its buttons stay within the list's width.
  const row = (await item.boundingBox())!;
  const revoke = (await item.getByRole("button", { name: "Revoke" }).boundingBox())!;
  expect(revoke.x + revoke.width).toBeLessThanOrEqual(row.x + row.width + 1);
});
