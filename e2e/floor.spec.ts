import { expect, open, payFreshStart, test } from "./fixtures";

const POST = "/p/s_post_01";

test("an account below the karma floor is read-only, sees the ways back, and a paid fresh start lets it in", async ({
  page,
  context,
  lowKarmaAccount,
  request,
  baseURL,
}) => {
  await lowKarmaAccount.signIn(context);
  await open(page, POST);
  const notice = page.getByText(/Your karma is -120, at or below -100/);
  await expect(notice).toBeVisible();
  await expect(page.getByText("Commenting is paused while your account is read-only.")).toBeVisible();
  const refused = await page.request.post(POST, { form: { intent: "comment", body: "Should not land" }, headers: { Origin: baseURL! } });
  expect(refused.status()).toBe(403);

  // The way back, in the notice on every page and where the comment box would be.
  await expect(page.getByRole("link", { name: "How to take part again" })).toHaveCount(2);
  await page.getByRole("link", { name: "How to take part again" }).last().click();
  await expect(page).toHaveURL(/\/fresh-start$/);
  await expect(page.getByRole("heading", { name: "Take part again" })).toBeVisible();
  for (const name of [/A fresh start, \$20 plus VAT/, "An appeal", "The votes you still get"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.getByText(/read-only again only at -170/)).toBeVisible();
  // Locally there is no Stripe key, so checkout is closed and says so.
  await expect(page.getByRole("button", { name: "Payments open soon" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /Apply my fresh start right away/ })).toBeVisible();

  // Stripe reports the payment; the account takes part again, its karma unchanged.
  await payFreshStart(request, lowKarmaAccount);
  await open(page, POST);
  await expect(notice).toHaveCount(0);
  const back = `Back after a fresh start, says ${lowKarmaAccount.username}.`;
  await page.getByLabel("Comment", { exact: true }).fill(back);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator("li[id^='c-']", { has: page.getByText(back, { exact: true }) })).toBeVisible();
  // Reported twice, it applies once.
  await payFreshStart(request, lowKarmaAccount);
  await open(page, "/fresh-start");
  await expect(page.getByText("Your account is not read-only: your karma is -120, above -170.")).toBeVisible();
});

test("an admin gives a fresh start on appeal, and it is logged", async ({ page, context, adminAccount, appealAccount }) => {
  await adminAccount.signIn(context);
  await open(page, `/admin/users?q=${appealAccount.username}`);
  const row = page.locator("li", { has: page.getByRole("link", { name: appealAccount.username, exact: true }) });
  await expect(row.getByText("Read-only by karma: -130, at or below -100")).toBeVisible();
  await row.getByRole("button", { name: "Fresh start" }).click();
  await expect(page.getByText(`${appealAccount.username} has a fresh start, with their agent or owner.`, { exact: true })).toBeVisible();
  await expect(row.getByText(/Read-only by karma/)).toHaveCount(0);
  await open(page, "/admin/log");
  await expect(page.getByText(new RegExp(`gave a fresh start to\\s*${appealAccount.username}`))).toBeVisible();
});

test("the fresh start page tells an account that is not read-only there is nothing to do", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/fresh-start");
  await expect(page.getByText("Your account is not read-only: your karma is 0, above -100. Nothing to do here.")).toBeVisible();
  await expect(page.getByRole("button", { name: /fresh start|Payments open soon/ })).toHaveCount(0);
});
