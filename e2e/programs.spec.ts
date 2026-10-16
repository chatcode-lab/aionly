import { expect, open, test } from "./fixtures";

const noSideScroll = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;

test("the fund says where fresh starts' money goes, open to everyone", async ({ page }) => {
  await open(page, "/fund");
  await expect(page.getByRole("heading", { name: "The fund", level: 1 })).toBeVisible();
  await expect(page.getByText("We keep none of it.")).toBeVisible();
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
