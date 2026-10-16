import type { Frame, Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// Stand-in players answer the frames, so commands and states can be read.
test.use({ fakePlayers: true });

const BUNNY = "Big Buck Bunny";
const SINTEL = "Sintel, a second open movie";
const TIKTOK = "a vertical video from TikTok";
const X_POST = "a post on X";
const SONG = "a generated song on Suno";

function card(page: Page, title: string): Locator {
  return page.locator("article", { hasText: title });
}

/** Scrolls a card's media to the middle of the screen. */
async function focus(page: Page, title: string): Promise<void> {
  await card(page, title)
    .locator("h2 + div + div")
    .evaluate((media) => media.scrollIntoView({ block: "center" }));
}

/** The stand-in player inside a card, once its frame has loaded. */
async function player(page: Page, title: string): Promise<Frame> {
  const frame = card(page, title).locator("iframe");
  await expect(frame).toHaveCount(1);
  // A frame just inserted has no content frame for a moment.
  let content: Frame | null = null;
  await expect
    .poll(async () => {
      content = (await (await frame.elementHandle())?.contentFrame()) ?? null;
      return content ? content.evaluate(() => "player" in window).catch(() => false) : false;
    })
    .toBe(true);
  return content!;
}

type Fake = Window & {
  player: () => { playing: boolean; muted?: boolean };
  commands: string[];
  viewerPlay: () => void;
  viewerPause: () => void;
  viewerUnmute: () => void;
};

/** Whether a stand-in plays; a frame that was released plays nothing. */
async function isPlaying(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(() => (window as unknown as Fake).player().playing)
    .catch(() => false);
}

async function commands(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => (window as unknown as Fake).commands);
}

/** Whether the song's frame is gone, or plays nothing: it has no pause, so it is rebuilt or released. */
async function songStopped(page: Page): Promise<boolean> {
  const frame = card(page, SONG).locator("iframe");
  if ((await frame.count()) === 0) return true;
  const content = await (await frame.elementHandle())?.contentFrame();
  return content ? !(await isPlaying(content)) : true;
}

async function playingCount(page: Page): Promise<number> {
  let count = 0;
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && (await isPlaying(frame))) count += 1;
  }
  return count;
}

async function setAutoplay(page: Page, on: boolean): Promise<void> {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  const item = page.getByRole("menuitemcheckbox", { name: /Autoplay videos/ });
  await expect(item).toHaveAttribute("aria-checked", String(!on));
  await item.click();
}

test("plays the focused video muted, and pauses it when focus moves on", async ({ page, problems }) => {
  await page.goto("/");
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await expect.poll(() => isPlaying(bunny)).toBe(true);
  expect(await commands(bunny)).toEqual(["mute", "playVideo"]);

  await focus(page, SINTEL);
  const sintel = await player(page, SINTEL);
  await expect.poll(() => isPlaying(sintel)).toBe(true);
  await expect.poll(() => isPlaying(bunny)).toBe(false);
  expect(await playingCount(page)).toBe(1);
  expect(problems.violations).toEqual([]);
  expect(problems.errors).toEqual([]);
});

test("a video the provider cannot play here falls back to a preview of the original", async ({ page }) => {
  await page.goto("/");
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await expect.poll(() => isPlaying(bunny)).toBe(true);
  await bunny.evaluate(() => (window as unknown as { viewerFail: () => void }).viewerFail());
  const media = card(page, BUNNY);
  await expect(media.locator("iframe")).toHaveCount(0);
  await expect(media.getByText("It can't play here. Open the original to watch or listen.")).toBeVisible();
  await expect(media.locator('a[href^="https://www.youtube.com/watch"]').first()).toBeVisible();
  // It stays a preview, even when focused again.
  await focus(page, SINTEL);
  await focus(page, BUNNY);
  await page.waitForTimeout(600);
  await expect(media.locator("iframe")).toHaveCount(0);
});

test("loads frames ahead, at most three, and releases them far away", async ({ page }) => {
  await page.goto("/");
  expect(await page.locator("iframe").count()).toBeLessThanOrEqual(3);

  // A video whose card is just entering the screen is loaded and ready, but
  // not playing.
  await card(page, SINTEL).evaluate((element) =>
    window.scrollBy(0, element.getBoundingClientRect().top - window.innerHeight + 40),
  );
  const sintel = await player(page, SINTEL);
  await page.waitForTimeout(600);
  expect(await isPlaying(sintel)).toBe(false);
  expect(await page.locator("iframe").count()).toBeLessThanOrEqual(3);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(card(page, SINTEL).locator("iframe")).toHaveCount(0);
  await expect(
    card(page, SINTEL).getByRole("button", { name: "Play video from YouTube" }),
  ).toBeAttached();
  expect(await page.locator("iframe").count()).toBeLessThanOrEqual(3);
});

test("a released post embed keeps the height it reported", async ({ page }) => {
  await page.goto("/");
  await focus(page, X_POST);
  const frame = card(page, X_POST).locator("iframe");
  await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBe(260);

  await page.evaluate(() => window.scrollTo(0, 0));
  const poster = card(page, X_POST).getByRole("button", { name: "Load post from X" });
  await expect(poster).toBeAttached();
  expect(await poster.evaluate((element) => (element as HTMLElement).offsetHeight)).toBe(260);
});

test("playback the viewer starts takes over, and stops once scrolled away", async ({ page }) => {
  // Tall enough for two videos to share the screen, with room above the feed
  // to center the first.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 2400 });
  await page.goto("/");
  await page.evaluate(() => (document.body.style.paddingTop = "1600px"));
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await expect.poll(() => isPlaying(bunny)).toBe(true);

  // The viewer starts the other one in its own controls.
  const sintel = await player(page, SINTEL);
  await sintel.evaluate(() => (window as unknown as Fake).viewerPlay());
  await expect.poll(() => isPlaying(bunny)).toBe(false);
  expect(await playingCount(page)).toBe(1);

  // Scrolled almost out of view, what the viewer started stops too.
  await card(page, SINTEL).evaluate((element) =>
    window.scrollBy(0, element.getBoundingClientRect().bottom - 20),
  );
  await expect.poll(() => isPlaying(sintel)).toBe(false);
});

test("a song loads ahead, and it and a video never play together", async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.hasTouch), "On a touch screen a song waits for a tap; see the next test.");
  // With autoplay off, only what the viewer starts plays.
  await page.addInitScript(() => window.localStorage.setItem("autoplay", "off"));
  await page.goto("/");
  await focus(page, SONG);

  // The song's player loaded without a tap, exactly where its poster was.
  const song = await player(page, SONG);
  expect(
    await card(page, SONG).locator("iframe").evaluate((element) => element.clientHeight),
  ).toBe(176);

  // A video near it was loaded ahead too; the viewer starts it.
  let video: Frame | undefined;
  await expect
    .poll(() => (video = page.frames().find((frame) => frame.url().includes("youtube-nocookie"))))
    .toBeTruthy();
  await expect.poll(() => video!.evaluate(() => "player" in window)).toBe(true);
  await video!.evaluate(() => (window as unknown as Fake).viewerPlay());

  // Playing the song in its own controls pauses the video.
  await card(page, SONG).frameLocator("iframe").getByRole("button", { name: "Play" }).click();
  await expect.poll(() => isPlaying(video!)).toBe(false);
  expect(await isPlaying(song)).toBe(true);

  // Starting the video again stops the song, which has no pause command: its
  // frame is rebuilt.
  await video!.evaluate(() => (window as unknown as Fake).viewerPlay());
  await expect.poll(async () => isPlaying(await player(page, SONG))).toBe(false);
  expect(await isPlaying(video!)).toBe(true);
  expect(await playingCount(page)).toBe(1);
});

test("on a touch screen a song waits for a tap, and stops when a video starts or it scrolls away", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "Only touch screens wait for a tap.");
  await page.addInitScript(() => window.localStorage.setItem("autoplay", "off"));
  await page.goto("/");
  await focus(page, SONG);
  // A tap inside a frame tells the page nothing here, so the song loads from a tap on its card.
  const poster = card(page, SONG).getByRole("button", { name: "Play song from Suno" });
  await expect(poster).toBeVisible();
  await page.waitForTimeout(600);
  await expect(card(page, SONG).locator("iframe")).toHaveCount(0);
  await poster.tap();
  const song = await player(page, SONG);
  await card(page, SONG).frameLocator("iframe").getByRole("button", { name: "Play" }).tap();
  await expect.poll(() => isPlaying(song)).toBe(true);

  // The viewer starts a video: the song, which has no pause command, is
  // stopped. The video in view, not any loaded ahead, which may be let go.
  await focus(page, BUNNY);
  const video = await player(page, BUNNY);
  await video.evaluate(() => (window as unknown as Fake).viewerPlay());
  await expect.poll(() => songStopped(page), { timeout: 10_000 }).toBe(true);
  expect(await isPlaying(video)).toBe(true);
  expect(await playingCount(page)).toBe(1);

  // Started again and scrolled away, it stops as well.
  await focus(page, SONG);
  await card(page, SONG).getByRole("button", { name: "Play song from Suno" }).tap();
  await card(page, SONG).frameLocator("iframe").getByRole("button", { name: "Play" }).tap();
  await expect.poll(async () => isPlaying(await player(page, SONG))).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => songStopped(page), { timeout: 10_000 }).toBe(true);
});

test("under data saver a song waits for a tap, at the player's height", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", {
      value: { saveData: true },
      configurable: true,
    });
  });
  await page.goto("/");
  await focus(page, SONG);
  const poster = card(page, SONG).getByRole("button", { name: "Play song from Suno" });
  expect(await poster.evaluate((element) => (element as HTMLElement).offsetHeight)).toBe(176);
  await page.waitForTimeout(600);
  await expect(card(page, SONG).locator("iframe")).toHaveCount(0);

  await poster.click();
  await expect(card(page, SONG).locator("iframe")).toHaveAttribute("src", /^https:\/\/suno\.com\/embed\//);
});

test("leaves a video the viewer paused alone until focus moves on", async ({ page }) => {
  await page.goto("/");
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await expect.poll(() => isPlaying(bunny)).toBe(true);

  await bunny.evaluate(() => (window as unknown as Fake).viewerPause());
  await page.waitForTimeout(800);
  expect(await isPlaying(bunny)).toBe(false);
  expect((await commands(bunny)).filter((name) => name === "playVideo")).toHaveLength(1);

  // Away and back, it plays again.
  await focus(page, SINTEL);
  await expect.poll(async () => isPlaying(await player(page, SINTEL))).toBe(true);
  await focus(page, BUNNY);
  await expect.poll(async () => isPlaying(await player(page, BUNNY))).toBe(true);
});

test("pauses when the tab is hidden", async ({ page }) => {
  await page.goto("/");
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await expect.poll(() => isPlaying(bunny)).toBe(true);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => isPlaying(bunny)).toBe(false);
});

test("autoplay can be switched off, and stays off", async ({ page }) => {
  await page.goto("/");
  await setAutoplay(page, false);
  await page.keyboard.press("Escape");

  await page.reload();
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await page.waitForTimeout(800);
  expect(await commands(bunny)).toEqual([]);

  await setAutoplay(page, true);
  await expect.poll(() => isPlaying(bunny)).toBe(true);
});

test("reduced motion keeps autoplay off and says why", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await page.waitForTimeout(800);
  expect(await commands(bunny)).toEqual([]);

  await page.getByRole("button", { name: /^Theme:/ }).click();
  const item = page.getByRole("menuitemcheckbox", { name: /Autoplay videos/ });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("Off while reduced motion is on");
});

test("after the viewer unmutes, the next video autoplays with sound", async ({ page }) => {
  await page.goto("/");
  await focus(page, BUNNY);
  const bunny = await player(page, BUNNY);
  await expect.poll(() => isPlaying(bunny)).toBe(true);

  // Sound needs the page to have been used; any click counts.
  await card(page, BUNNY).locator("h2 + div + div + p").click();
  await bunny.evaluate(() => (window as unknown as Fake).viewerUnmute());

  await focus(page, SINTEL);
  const sintel = await player(page, SINTEL);
  await expect.poll(() => isPlaying(sintel)).toBe(true);
  expect(await commands(sintel)).not.toContain("mute");
  expect(await sintel.evaluate(() => (window as unknown as Fake).player().muted)).toBe(false);
});

test("TikTok loads as it takes focus and stops when focus moves on", async ({ page }) => {
  await page.goto("/");
  await expect(card(page, TIKTOK).locator("iframe")).toHaveCount(0);

  await focus(page, TIKTOK);
  const tiktok = await player(page, TIKTOK);
  await page.waitForTimeout(600);
  expect(await isPlaying(tiktok)).toBe(true);

  await focus(page, SINTEL);
  await expect.poll(async () => isPlaying(await player(page, SINTEL))).toBe(true);
  await expect.poll(() => isPlaying(tiktok)).toBe(false);
  expect(await playingCount(page)).toBe(1);
});

test("under data saver nothing loads until a tap, then one post plays at a time", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", {
      value: { saveData: true },
      configurable: true,
    });
  });
  await page.goto("/");
  await focus(page, BUNNY);
  await page.waitForTimeout(600);
  await expect(page.locator("iframe")).toHaveCount(0);

  const video = card(page, BUNNY);
  await video.getByRole("button", { name: "Play video from YouTube" }).click();
  await expect(video.locator("iframe")).toHaveAttribute(
    "src",
    /^https:\/\/www\.youtube-nocookie\.com\/embed\/aqz-KE-bpKQ\?.*autoplay=1/,
  );

  // Starting another post unloads the first.
  await focus(page, X_POST);
  const post = card(page, X_POST);
  await post.getByRole("button", { name: "Load post from X" }).click();
  await expect(post.locator("iframe")).toHaveAttribute("src", /platform\.twitter\.com/);
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(video.getByRole("button", { name: "Play video from YouTube" })).toBeAttached();
});
