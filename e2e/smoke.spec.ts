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
    // The forged requests carry no body. The Worker refuses them before
    // reading one, and the local preview proxy sometimes fails with a 500
    // when a body is still in flight at that point.
    const forged = (origin?: string) =>
      request.post("/theme", { headers: origin ? { Origin: origin } : {} });

    expect((await forged("https://evil.example")).status()).toBe(403);
    expect((await forged()).status()).toBe(403);

    const genuine = await request.post("/theme", {
      form: { theme: "dark" },
      headers: { Origin: new URL(baseURL!).origin },
    });
    expect(genuine.status()).toBe(200);
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

test.describe("removed embed shell", () => {
  test("no first-party frame route remains", async ({ request }) => {
    for (const path of ["/embed/shell/x/20", "/embed/shell/reddit/tqbguc"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["content-security-policy"], path).toContain(
        "frame-ancestors 'none'",
      );
    }
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

  test("themes post embeds from the site and re-themes them on a switch", async ({
    page,
    context,
    baseURL,
    problems,
  }) => {
    await context.addCookies([{ name: "theme", value: "light", url: baseURL! }]);
    await page.goto("/dev/embeds");
    const section = (name: string) =>
      page.locator("section", {
        has: page.getByRole("heading", { name, exact: true }),
      });

    const reddit = section("Reddit");
    await expect(reddit).toContainText("reddit:tqbguc · post · uncontrolled");
    await reddit.getByRole("button", { name: "Load", exact: true }).click();
    // Light is Reddit's default: the compact layout with no theme parameter.
    await expect(reddit.locator("iframe")).toHaveAttribute(
      "src",
      "https://embed.reddit.com/r/place/comments/tqbguc/?embed=true&style=subreddit-first",
    );

    const x = section("X");
    await x.getByRole("button", { name: "Load", exact: true }).click();
    await expect(x.locator("iframe")).toHaveAttribute("src", /theme=light/);

    const suno = section("Suno");
    await suno.getByRole("button", { name: "Load", exact: true }).click();
    await expect(suno.locator("iframe")).toHaveAttribute("src", /\?theme=light$/);

    const telegram = section("Telegram");
    await expect(telegram).toContainText("telegram:telegram/83 · post · uncontrolled");
    await telegram.getByRole("button", { name: "Load", exact: true }).click();
    await expect(telegram.locator("iframe")).toHaveAttribute(
      "src",
      "https://t.me/telegram/83?embed=1&userpic=false",
    );

    // Switching the site theme rebuilds every mounted frame in that theme.
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(reddit.locator("iframe")).toHaveAttribute("src", /&theme=dark$/);
    await expect(x.locator("iframe")).toHaveAttribute("src", /theme=dark/);
    await expect(suno.locator("iframe")).toHaveAttribute("src", /\?theme=dark$/);
    await expect(telegram.locator("iframe")).toHaveAttribute("src", /&dark=1$/);

    expect(problems.violations).toEqual([]);
  });

  test("keeps a post embed at the provider's width with no backdrop", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
    await page.goto("/dev/embeds");
    const x = page.locator("section", {
      has: page.getByRole("heading", { name: "X", exact: true }),
    });
    await x.getByRole("button", { name: "Load", exact: true }).click();

    const frame = x.locator("iframe");
    // A transparent, light-only document gets an opaque white backdrop on a
    // dark page unless its frame is itself marked light.
    await expect(frame).toHaveCSS("color-scheme", "light");
    const box = await frame.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(550);
  });

  test("never scrolls inside an embed that reports its own height", async ({ page }) => {
    await page.goto("/dev/embeds");
    for (const name of ["X", "Reddit", "Telegram"]) {
      const section = page.locator("section", {
        has: page.getByRole("heading", { name, exact: true }),
      });
      await section.getByRole("button", { name: "Load", exact: true }).click();
      await expect(section.locator("iframe"), name).toHaveAttribute("scrolling", "no");
    }
  });

  test("shows a vertical video at its own size with no box around it", async ({ page }) => {
    await page.goto("/dev/embeds");
    const tiktok = page.locator("section", {
      has: page.getByRole("heading", { name: "TikTok", exact: true }),
    });
    await tiktok.getByRole("button", { name: "Load", exact: true }).click();

    const frame = tiktok.locator("iframe");
    await expect(frame).toHaveCSS("border-radius", "12px");
    const wrapper = frame.locator("xpath=..");
    await expect(wrapper).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    // As wide as the column allows up to 320 px, and centered in it.
    const [frameBox, wrapperBox] = [await frame.boundingBox(), await wrapper.boundingBox()];
    expect(frameBox!.width).toBeCloseTo(Math.min(wrapperBox!.width, 320), 0);
    const left = frameBox!.x - wrapperBox!.x;
    const right = wrapperBox!.x + wrapperBox!.width - (frameBox!.x + frameBox!.width);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    expect(frameBox!.height / frameBox!.width).toBeCloseTo(16 / 9, 1);
  });

  test("offers only the commands each player obeys", async ({ page }) => {
    await page.goto("/dev/embeds");
    const section = (name: string) =>
      page.locator("section", {
        has: page.getByRole("heading", { name, exact: true }),
      });

    const tiktok = section("TikTok");
    await tiktok.getByRole("button", { name: "Load", exact: true }).click();
    // TikTok only answers once playing, and undoes mute commands.
    await expect(tiktok.locator("iframe")).toHaveAttribute("src", /autoplay=1/);
    await expect(tiktok.locator("iframe")).not.toHaveAttribute("src", /muted=/);
    await expect(tiktok.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(tiktok.getByRole("button", { name: "Mute", exact: true })).toHaveCount(0);

    const youtube = section("YouTube");
    await youtube.getByRole("button", { name: "Load", exact: true }).click();
    await expect(youtube.getByRole("button", { name: "Unmute" })).toBeVisible();
  });
});

test.describe("narrow screens", () => {
  test("no page scrolls sideways", async ({ page }) => {
    const overflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );

    for (const path of [
      "/",
      "/?range=all",
      "/p/s_post_01",
      "/p/s_post_17",
      "/u/quiet_otter_482",
      "/dev/ui",
      "/dev/embeds",
    ]) {
      await page.goto(path);
      expect(await overflow(), path).toBeLessThanOrEqual(0);
    }

    // With every provider's frame and controls mounted, too.
    const loads = page.getByRole("button", { name: "Load", exact: true });
    await expect(loads).toHaveCount(6);
    while ((await loads.count()) > 0) await loads.first().click();
    await expect(page.locator("iframe")).toHaveCount(6);
    expect(await overflow(), "embeds mounted").toBeLessThanOrEqual(0);
  });

  test("scales Telegram to fit instead of cropping it", async ({ page, viewport }) => {
    await page.goto("/dev/embeds");
    const telegram = page.locator("section", {
      has: page.getByRole("heading", { name: "Telegram", exact: true }),
    });
    await telegram.getByRole("button", { name: "Load", exact: true }).click();

    const frame = telegram.locator("iframe");
    // Its bubble has a tail at the corner, which rounding the frame would clip.
    await expect(frame).toHaveCSS("border-radius", "0px");
    const wrapper = frame.locator("xpath=..");
    const [frameBox, wrapperBox] = [await frame.boundingBox(), await wrapper.boundingBox()];

    // The post is never wider on screen than its column.
    expect(frameBox!.width).toBeLessThanOrEqual(wrapperBox!.width + 0.5);
    if (viewport!.width < 400) {
      // In a column under 320 px the frame keeps Telegram's minimum layout
      // width and is shrunk to fit.
      await expect(frame).toHaveCSS("width", "320px");
      expect(frameBox!.width).toBeCloseTo(wrapperBox!.width, 0);
    }
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
      await expect(page.locator("article")).toHaveCount(12);

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

  test("keeps the top bar on one row on a wide screen", async ({ page, viewport }) => {
    test.skip(viewport!.width < 768, "the toolbar wraps below this width by design");
    await page.goto("/dev/ui");
    const bar = page.locator("header", { has: page.getByRole("navigation", { name: "Sort" }) });
    const logo = await bar.getByRole("link", { name: "aion.ly home" }).boundingBox();
    const account = await bar.getByRole("button", { name: /^Account:/ }).boundingBox();
    // Same row: the account button's center lies within the logo's height.
    const center = account!.y + account!.height / 2;
    expect(center).toBeGreaterThan(logo!.y);
    expect(center).toBeLessThan(logo!.y + logo!.height);
  });

  test("picks the range from one button", async ({ page }) => {
    await page.goto("/dev/ui");
    await page.getByRole("button", { name: "Range: Week" }).click();
    await page.getByRole("menuitem", { name: "Month" }).click();

    await expect(page).toHaveURL(/range=month/);
    await expect(page.getByRole("button", { name: "Range: Month" })).toBeVisible();
  });

  test("copies a post's link from its card", async ({ page }) => {
    await page.goto("/dev/ui");
    const card = page.locator("article").first();
    await card.getByRole("button", { name: "Copy link" }).click();
    await expect(card.getByRole("status")).toHaveText("Link copied");
  });

  test("saves a post from its card", async ({ page }) => {
    await page.goto("/dev/ui");
    const card = page.locator("article").first();

    const save = card.getByRole("button", { name: "Save post" });
    await expect(save).toHaveAttribute("aria-pressed", "false");
    await save.click();
    await expect(
      card.getByRole("button", { name: "Remove from saved" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("shows the digest and uploads as coming soon, not as working", async ({ page }) => {
    await page.goto("/dev/ui");

    await page.getByRole("button", { name: /^Email digest:/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("Soon");
    for (const option of ["Daily", "Weekly", "Monthly"]) {
      await expect(
        menu.getByRole("menuitemradio", { name: option }),
      ).toHaveAttribute("aria-disabled", "true");
    }
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText("Upload a picture, video, or audio")).toBeVisible();
    const form = page.locator("form", {
      has: page.getByRole("group", { name: "Post from" }),
    });
    await expect(form.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  test("marks an agent's comment", async ({ page }) => {
    await page.goto("/dev/ui");
    const comment = page.locator("li", { hasText: "scribe_agent" }).last();
    await expect(comment.getByText("Agent", { exact: true })).toBeVisible();
  });

  test("a low-score comment starts hidden and can be shown", async ({ page }) => {
    await page.goto("/dev/ui");
    const hidden = "This comment sits at minus seven";
    await expect(page.getByText(hidden)).toHaveCount(0);
    await page.getByRole("button", { name: "Show comment" }).click();
    await expect(page.getByText(hidden)).toBeVisible();
  });
});
