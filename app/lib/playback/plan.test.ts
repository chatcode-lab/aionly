import { describe, expect, it } from "vitest";

import {
  focusCandidate,
  type MountInput,
  onScreen,
  planMounts,
  screensAway,
  type SlotBox,
  type SlotKind,
} from "./plan";

const VH = 800;

function box(key: string, kind: SlotKind, top: number, height = 300): SlotBox {
  return { key, kind, top, bottom: top + height };
}

function input(overrides: Partial<MountInput>): MountInput {
  return {
    boxes: [],
    viewportHeight: VH,
    mounted: new Set(),
    held: new Set(),
    candidate: null,
    loadAhead: true,
    autoplay: true,
    ...overrides,
  };
}

describe("onScreen", () => {
  it("measures the visible share", () => {
    expect(onScreen(box("a", "video", 0), VH)).toBe(1);
    expect(onScreen(box("a", "video", -150), VH)).toBe(0.5);
    expect(onScreen(box("a", "video", 650), VH)).toBe(0.5);
    expect(onScreen(box("a", "video", 900), VH)).toBe(0);
  });

  it("counts a box taller than the screen as fully on screen when it fills it", () => {
    expect(onScreen(box("a", "video", -100, 1200), VH)).toBe(1);
  });
});

describe("screensAway", () => {
  it("is zero on screen and grows in screen heights either side", () => {
    expect(screensAway(box("a", "post", 100), VH)).toBe(0);
    expect(screensAway(box("a", "post", VH + 400), VH)).toBe(0.5);
    expect(screensAway(box("a", "post", -1100), VH)).toBe(1);
  });
});

describe("focusCandidate", () => {
  it("picks the video nearest the center", () => {
    const boxes = [box("top", "video", 0), box("middle", "video", 260)];
    expect(focusCandidate(boxes, VH)).toBe("middle");
  });

  it("ignores videos less than 60% on screen", () => {
    expect(focusCandidate([box("edge", "video", 650)], VH)).toBeNull();
  });

  it("never focuses a post embed or a song", () => {
    const boxes = [box("post", "post", 250), box("song", "song", 250)];
    expect(focusCandidate(boxes, VH)).toBeNull();
  });

  it("focuses TikTok like any video", () => {
    expect(focusCandidate([box("t", "tiktok", 200)], VH)).toBe("t");
  });

  it("never focuses a player that waits for the viewer, as in an article's text", () => {
    const boxes = [{ ...box("waits", "video", 250), waits: true }, { ...box("tiktok", "tiktok", 250), waits: true }, box("other", "video", 900)];
    expect(focusCandidate(boxes, VH)).toBeNull();
  });
});

describe("planMounts", () => {
  it("loads videos and posts from half a screen above to one below", () => {
    const boxes = [
      box("far-above", "video", -1000),
      box("near-above", "video", -500),
      box("on", "post", 100),
      box("near-below", "post", 1400),
      box("far-below", "video", 1700),
    ];
    expect(planMounts(input({ boxes }))).toEqual(
      new Set(["on", "near-above", "near-below"]),
    );
  });

  it("keeps a loaded frame until it is two screens away", () => {
    const boxes = [box("kept", "video", 2300), box("released", "video", 2500)];
    const mounted = new Set(["kept", "released"]);
    expect(planMounts(input({ boxes, mounted }))).toEqual(new Set(["kept"]));
  });

  it("loads at most three frames, nearest the center first", () => {
    const boxes = [0, 300, 600, 900, 1200].map((top, index) =>
      box(`v${index}`, "video", top),
    );
    expect(planMounts(input({ boxes }))).toEqual(new Set(["v0", "v1", "v2"]));
  });

  it("always keeps held frames, even past the cap", () => {
    const boxes = [
      box("a", "video", 0),
      box("b", "video", 300),
      box("c", "video", 600),
      box("held", "song", 5000),
    ];
    const result = planMounts(input({ boxes, held: new Set(["held"]) }));
    expect(result.has("held")).toBe(true);
    expect(result.size).toBe(3);
  });

  it("loads TikTok only as it takes focus, and only with autoplay on", () => {
    const boxes = [box("t", "tiktok", 200)];
    expect(planMounts(input({ boxes })).has("t")).toBe(false);
    expect(planMounts(input({ boxes, candidate: "t" })).has("t")).toBe(true);
    expect(
      planMounts(input({ boxes, candidate: "t", autoplay: false })).has("t"),
    ).toBe(false);
  });

  it("loads a waiting video ahead, held paused, and a waiting TikTok only from a tap", () => {
    const boxes = [{ ...box("v", "video", 200), waits: true }, { ...box("t", "tiktok", 600), waits: true }];
    expect(planMounts(input({ boxes })).has("v")).toBe(true);
    expect(planMounts(input({ boxes, candidate: "t" })).has("t")).toBe(false);
    expect(planMounts(input({ boxes, held: new Set(["t"]) })).has("t")).toBe(true);
  });

  it("releases TikTok half a screen away", () => {
    const boxes = [box("t", "tiktok", VH + 500)];
    const mounted = new Set(["t"]);
    expect(planMounts(input({ boxes, mounted })).has("t")).toBe(false);
  });

  it("loads songs ahead like post embeds, and never focuses them", () => {
    const boxes = [box("s", "song", VH + 300)];
    expect(planMounts(input({ boxes })).has("s")).toBe(true);
    expect(focusCandidate([box("s", "song", 100)], VH)).toBeNull();
    const far = [box("s", "song", VH * 4)];
    expect(planMounts(input({ boxes: far, mounted: new Set(["s"]) })).has("s")).toBe(false);
  });

  it("waits for a tap before loading a song on a touch screen, and keeps a tapped one", () => {
    const boxes = [box("s", "song", 100), box("v", "video", 500)];
    const touch = planMounts(input({ boxes, songsWaitForTap: true }));
    expect(touch.has("s")).toBe(false);
    // Videos still load ahead.
    expect(touch.has("v")).toBe(true);
    // A song loaded by a tap, and so held, stays.
    expect(planMounts(input({ boxes, songsWaitForTap: true, held: new Set(["s"]) })).has("s")).toBe(true);
    // A song loaded ahead before is let go once taps are needed.
    expect(planMounts(input({ boxes, songsWaitForTap: true, mounted: new Set(["s"]) })).has("s")).toBe(false);
  });

  it("loads nothing ahead under data saver", () => {
    const boxes = [
      box("v", "video", 100),
      box("p", "post", 500),
      box("s", "song", 700),
    ];
    expect(planMounts(input({ boxes, loadAhead: false })).size).toBe(0);
  });
});
