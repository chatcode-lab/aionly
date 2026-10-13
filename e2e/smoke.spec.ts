import { expect, test } from "./fixtures";

test.describe("security baseline", () => {
  test("every page ships the site policy and can be read without violations", async ({
    page,
    problems,
  }) => {
    for (const path of ["/", "/dev/ui", "/dev/embeds"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);

      const headers = response!.headers();
      const policy = headers["content-security-policy"];
      expect(policy, path).toContain("frame-ancestors 'none'");
      expect(policy, path).toMatch(/script-src 'self' 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com;/);
      expect(policy, path).not.toContain("ws:");
      expect(headers["x-frame-options"], path).toBe("DENY");
      // Staging is never indexed.
      expect(headers["x-robots-tag"], path).toBe("noindex");

      await expect(page.locator("footer")).toContainText("A Chatcode Lab project");
      await expect(
        page.locator('footer a[href="https://chatcode.dev/"]'),
      ).toBeVisible();
      await expect(
        page.locator('footer a[href="https://x.com/karulin"]'),
      ).toHaveText("@karulin");
    }

    expect(problems.violations).toEqual([]);
    expect(problems.errors).toEqual([]);
  });

  test("cross-site writes are refused", async ({ request, baseURL }) => {
    const send = (origin?: string) =>
      request.post("/theme", {
        form: { theme: "dark" },
        headers: origin ? { Origin: origin } : {},
      });

    expect((await send("https://evil.example")).status()).toBe(403);
    expect((await send()).status()).toBe(403);
    expect((await send(new URL(baseURL!).origin)).status()).toBe(200);
  });

  test("no page can be framed, not even by the site itself", async ({ page }) => {
    await page.goto("/dev/ui");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "self-frame";
      frame.src = "/";
      document.body.append(frame);
    });
    // Chromium replaces a frame blocked by `frame-ancestors` with an error page.
    await expect
      .poll(() => page.frames().some((f) => f.url().startsWith("chrome-error")))
      .toBe(true);
  });
});

test.describe("embed shell", () => {
  test("sends its own sandboxing policy", async ({ request, baseURL }) => {
    const response = await request.get("/embed/shell/x/20");
    expect(response.status()).toBe(200);

    const headers = response.headers();
    const policy = headers["content-security-policy"];
    expect(policy).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`frame-ancestors ${new URL(baseURL!).origin}`);
    expect(headers["x-frame-options"]).toBeUndefined();
  });

  test("rejects anything but a well-formed post ID", async ({ request }) => {
    for (const path of [
      "/embed/shell/x/not-a-post",
      "/embed/shell/youtube/dQw4w9WgXcQ",
      "/embed/shell/x/20%22%3E%3Cscript%3E",
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["content-security-policy"], path).toContain(
        "frame-ancestors 'none'",
      );
    }
  });

  test("is admitted by the site policy and reports its height from an opaque origin", async ({
    page,
    problems,
  }) => {
    await page.goto("/dev/embeds");
    const x = page.locator("section", { has: page.getByRole("heading", { name: "X", exact: true }) });

    await x.getByLabel("Use embed shell").check();
    await x.getByRole("button", { name: "Load", exact: true }).click();

    const frame = x.locator("iframe");
    await expect(frame).toHaveAttribute("src", /^\/embed\/shell\/x\/20\?theme=/);
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    // The shell's reporter posts from origin "null"; the page matches it by
    // source window and logs the decoded event.
    await expect(x.getByRole("log")).toContainText('"type":"height"');
    expect(problems.violations).toEqual([]);
  });

  test("cannot be framed from another origin", async ({ page, baseURL }) => {
    // A stand-in for some other site that tries to frame the shell.
    await page.route("https://other.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><iframe src="${baseURL}/embed/shell/x/20"></iframe>`,
      }),
    );
    await page.goto("https://other.example/");
    await expect
      .poll(() => page.frames().some((f) => f.url().startsWith("chrome-error")))
      .toBe(true);
  });
});

test.describe("embed spike", () => {
  test("mounts provider frames through the sandbox", async ({ page, problems }) => {
    await page.goto("/dev/embeds");
    const youtube = page.locator("section", {
      has: page.getByRole("heading", { name: "YouTube" }),
    });

    await expect(youtube).toContainText("youtube:jNQXAC9IVRw · 16:9 · controlled");
    await youtube.getByRole("button", { name: "Load", exact: true }).click();

    const frame = youtube.locator("iframe");
    await expect(frame).toHaveAttribute(
      "src",
      /^https:\/\/www\.youtube-nocookie\.com\/embed\/jNQXAC9IVRw\?enablejsapi=1&origin=/,
    );
    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(problems.violations).toEqual([]);
  });

  test("explains a rejected link instead of loading it", async ({ page }) => {
    await page.goto("/dev/embeds");
    const youtube = page.locator("section", {
      has: page.getByRole("heading", { name: "YouTube" }),
    });

    await youtube.getByLabel("Link").fill("http://www.youtube.com/watch?v=jNQXAC9IVRw");
    await expect(youtube.getByRole("alert")).toHaveText("Rejected: not_https");
    await expect(youtube.getByRole("button", { name: "Load", exact: true })).toBeDisabled();
  });
});

test.describe("theme", () => {
  test("is remembered and rendered by the server with no flash", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");

    await page.getByRole("button", { name: /^Theme:/ }).click();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.startsWith("/theme"),
    );
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    // Applied at once, before the server has answered.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await saved).status()).toBe(200);

    // The reloaded document arrives already dark, before any script runs.
    const response = await page.reload();
    expect(await response!.text()).toContain('data-theme="dark"');
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 17, 16)");
  });
});

test.describe("design review page", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`renders in the ${theme} theme`, async ({ page, context, baseURL, problems }, testInfo) => {
      await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
      await page.goto("/dev/ui");

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: "Design review" })).toBeVisible();
      await expect(page.locator("article")).toHaveCount(8);

      await page.screenshot({
        path: testInfo.outputPath(`dev-ui-${theme}.png`),
        fullPage: true,
      });
      expect(problems.violations).toEqual([]);
      expect(problems.errors).toEqual([]);
    });
  }

  test("votes toggle and report opens from the comment menu", async ({ page }) => {
    await page.goto("/dev/ui");
    const first = page.locator("article").first();
    const upvote = first.getByRole("button", { name: "Upvote" }).locator("visible=true");

    await expect(upvote).toHaveAttribute("aria-pressed", "true");
    await upvote.click();
    await expect(upvote).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Comment actions" }).first().click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    const dialog = page.getByRole("dialog", { name: "Report comment" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("a low-score comment starts hidden and can be shown", async ({ page }) => {
    await page.goto("/dev/ui");
    const hidden = "This comment sits at minus seven";
    await expect(page.getByText(hidden)).toHaveCount(0);
    await page.getByRole("button", { name: "Show comment" }).click();
    await expect(page.getByText(hidden)).toBeVisible();
  });
});
