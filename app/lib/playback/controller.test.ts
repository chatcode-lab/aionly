import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlaybackController, READY_DEADLINE_MS } from "./controller";

/** Just enough of a browser for the controller: no layout, no storage. */
function stubBrowser() {
  const listeners = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("window", {
    ...listeners,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, ...listeners }),
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  vi.stubGlobal("document", { ...listeners, visibilityState: "visible" });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
    },
  );
}

const element = () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 300 }) }) as unknown as HTMLElement;
const connection = () => ({ send() {}, disconnect() {} });

describe("a frame that never answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubBrowser();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("falls back to its preview once the deadline passes", () => {
    const controller = new PlaybackController();
    controller.register("v1", "p1", "video", element());
    controller.attach("v1", connection());
    vi.advanceTimersByTime(READY_DEADLINE_MS - 1);
    expect(controller.state("v1").failed).toBeFalsy();
    vi.advanceTimersByTime(1);
    expect(controller.state("v1").failed).toBe(true);
  });

  it("is left alone once it says it is ready, or sends its height", () => {
    const controller = new PlaybackController();
    controller.register("v1", "p1", "video", element());
    controller.register("x1", "p2", "post", element());
    controller.attach("v1", connection());
    controller.attach("x1", connection());
    controller.report("v1", { type: "ready" });
    controller.report("x1", { type: "height", height: 400 });
    vi.advanceTimersByTime(READY_DEADLINE_MS * 2);
    expect(controller.state("v1").failed).toBeFalsy();
    expect(controller.state("x1").failed).toBeFalsy();
  });

  it("gives a song, which never speaks, and a detached frame no deadline", () => {
    const controller = new PlaybackController();
    controller.register("s1", "p1", "song", element());
    controller.register("v1", "p2", "video", element());
    controller.attach("s1", connection());
    controller.attach("v1", connection());
    controller.detach("v1");
    vi.advanceTimersByTime(READY_DEADLINE_MS * 2);
    expect(controller.state("s1").failed).toBeFalsy();
    expect(controller.state("v1").failed).toBeFalsy();
  });
});

describe("a TikTok whose autoplay the browser refuses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubBrowser();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps its frame, and is not asked to play, before or after a tap on its own button", () => {
    const controller = new PlaybackController();
    const sent: string[] = [];
    controller.register("t1", "p1", "tiktok", element());
    controller.attach("t1", { send: (command: string) => sent.push(command), disconnect() {} });
    controller.report("t1", { type: "ready" });
    controller.report("t1", { type: "refused" });
    vi.advanceTimersByTime(READY_DEADLINE_MS * 2);
    expect(controller.state("t1").failed).toBeFalsy();
    expect(sent).toEqual([]);
    // A tap on its own play button.
    controller.report("t1", { type: "state", state: "playing" });
    expect(sent).toEqual([]);
    expect(controller.state("t1").failed).toBeFalsy();
  });
});
