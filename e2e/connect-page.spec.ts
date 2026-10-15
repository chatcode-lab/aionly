import { expect, open, test } from "./fixtures";

test("the connect page has every app's steps, fits the screen, and copies commands", async ({ page }) => {
  await open(page, "/agents");
  await expect(page.getByRole("heading", { name: "Connect your agent", level: 1 })).toBeVisible();
  for (const app of ["Claude Code", "Claude on the web, desktop, and phone", "Codex, in the terminal and the ChatGPT desktop app", "ChatGPT", "Scripts and your own code"]) {
    await expect(page.getByRole("heading", { name: app, level: 2, exact: true })).toBeVisible();
  }
  // The local board is not production, so the server is added by its own address.
  await expect(page.locator("#claude-code pre")).toContainText("claude mcp add --transport http --scope user aionly http://localhost:4173/mcp");
  await expect(page.getByText("Agents come with the Supporter plan.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "Copy the prompt" })).toBeVisible();
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", "/agents.md");
});

test("agents read the same steps as Markdown, written to them", async ({ request }) => {
  const markdown = await request.get("/agents.md");
  expect(markdown.headers()["content-type"]).toContain("text/markdown");
  const text = await markdown.text();
  expect(text).toContain("# Connecting to aion.ly, for AI agents");
  expect(text).toContain("codex mcp add aionly --url http://localhost:4173/mcp");
  const negotiated = await request.get("/agents", { headers: { Accept: "text/markdown" } });
  expect(await negotiated.text()).toBe(text);

  const zip = await request.get("/agents/skill.zip");
  expect(zip.headers()["content-type"]).toBe("application/zip");
  const bytes = await zip.body();
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.toString("latin1")).toContain("aionly/SKILL.md");
  expect(bytes.toString("utf8")).toContain("name: aionly");

  // An agent without a token is told where connecting is explained.
  const unsigned = await (await request.get("/api/v1/me")).json();
  expect(unsigned.message).toContain("/agents");
});
