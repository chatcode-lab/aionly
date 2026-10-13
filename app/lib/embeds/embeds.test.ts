import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectInAppBrowser } from "../in-app-browser";
import type { MediaLink, Provider } from "../links/types";
import { connectEmbed } from "./connect";
import { FRAME_SANDBOX, frameUrl, SHELL_SANDBOX, shellPath } from "./frames";
import {
  decodeInstagram,
  decodeShell,
  decodeTikTok,
  decodeX,
  decodeYouTube,
  type EmbedEvent,
  tiktokCommand,
  youtubeCommand,
} from "./messages";
import { isShellId, SHELL_HEIGHT_MESSAGE, shellDocument } from "./shell";

const SITE = "https://aion.ly";

function link(provider: Provider, id: string): MediaLink {
  return {
    kind: "media",
    provider,
    id,
    canonicalKey: `${provider}:${id}`,
    aspect: "16:9",
    controlled: provider === "youtube" || provider === "tiktok",
  };
}

describe("frameUrl", () => {
  const options = { siteOrigin: SITE, theme: "dark" as const };

  it("builds the frame for each provider from its ID", () => {
    expect(frameUrl(link("youtube", "dQw4w9WgXcQ"), options)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&origin=https%3A%2F%2Faion.ly&playsinline=1&rel=0",
    );
    expect(frameUrl(link("tiktok", "6718335390845095173"), options)).toBe(
      "https://www.tiktok.com/player/v1/6718335390845095173?controls=1&rel=0&music_info=0&description=0",
    );
    expect(
      frameUrl(link("suno", "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"), options),
    ).toBe("https://suno.com/embed/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d");
    expect(frameUrl(link("instagram", "CxYz_12-AbC"), options)).toBe(
      "https://www.instagram.com/p/CxYz_12-AbC/embed/",
    );
    expect(frameUrl(link("x", "20"), options)).toBe(
      "https://platform.twitter.com/embed/Tweet.html?id=20&theme=dark&dnt=true",
    );
  });

  it("starts controlled players muted for the card in focus", () => {
    const youtube = new URL(
      frameUrl(link("youtube", "dQw4w9WgXcQ"), { ...options, autoplay: "muted" }),
    );
    expect(youtube.searchParams.get("autoplay")).toBe("1");
    expect(youtube.searchParams.get("mute")).toBe("1");

    const tiktok = new URL(
      frameUrl(link("tiktok", "6718335390845095173"), {
        ...options,
        autoplay: "muted",
      }),
    );
    expect(tiktok.searchParams.get("autoplay")).toBe("1");
    expect(tiktok.searchParams.get("muted")).toBe("1");
  });

  it("starts with sound after a tap on the poster", () => {
    const youtube = new URL(
      frameUrl(link("youtube", "dQw4w9WgXcQ"), { ...options, autoplay: "sound" }),
    );
    expect(youtube.searchParams.get("autoplay")).toBe("1");
    expect(youtube.searchParams.has("mute")).toBe(false);

    const tiktok = new URL(
      frameUrl(link("tiktok", "6718335390845095173"), {
        ...options,
        autoplay: "sound",
      }),
    );
    expect(tiktok.searchParams.get("autoplay")).toBe("1");
    expect(tiktok.searchParams.has("muted")).toBe(false);
  });

  it("cannot be steered off the provider by a hand-built ID", () => {
    const url = new URL(frameUrl(link("suno", "../../evil?x=1#y"), options));
    expect(url.origin).toBe("https://suno.com");
    expect(url.pathname).toBe("/embed/..%2F..%2Fevil%3Fx%3D1%23y");
    expect(url.search).toBe("");
  });

  it("never lets a frame navigate the top window", () => {
    for (const sandbox of [FRAME_SANDBOX, SHELL_SANDBOX]) {
      expect(sandbox).not.toContain("allow-top-navigation");
    }
    expect(SHELL_SANDBOX).not.toContain("allow-same-origin");
  });
});

describe("embed shell", () => {
  it("accepts only well-formed provider IDs", () => {
    expect(isShellId("x", "20")).toBe(true);
    expect(isShellId("x", "1234567890123456789")).toBe(true);
    expect(isShellId("instagram", "CxYz_12-AbC")).toBe(true);
    for (const id of ["", "abc", "20/../x", '20"><script>', "123456789012345678901"]) {
      expect(isShellId("x", id)).toBe(false);
    }
    for (const id of ["", "a b c d e", "Cx/Yz", '"><script>', "x".repeat(41)]) {
      expect(isShellId("instagram", id)).toBe(false);
    }
  });

  it("renders one post, the provider script, and the height reporter", () => {
    const html = shellDocument({
      provider: "x",
      id: "20",
      nonce: "abc",
      siteOrigin: SITE,
      theme: "dark",
    });
    expect(html).toContain('href="https://twitter.com/i/status/20"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain(
      '<script nonce="abc" async src="https://platform.twitter.com/widgets.js"',
    );
    expect(html).toContain(`type:"${SHELL_HEIGHT_MESSAGE}"`);
    expect(html).toContain(`},"${SITE}")`);
    // Exactly two scripts, and both carry the nonce.
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html.match(/<script nonce="abc"/g)).toHaveLength(2);
  });

  it("renders Instagram posts through Instagram's script", () => {
    const html = shellDocument({
      provider: "instagram",
      id: "CxYz_12-AbC",
      nonce: "abc",
      siteOrigin: SITE,
      theme: "light",
    });
    expect(html).toContain(
      'data-instgrm-permalink="https://www.instagram.com/p/CxYz_12-AbC/"',
    );
    expect(html).toContain('src="https://www.instagram.com/embed.js"');
  });

  it("refuses an unvalidated ID rather than rendering it", () => {
    expect(() =>
      shellDocument({
        provider: "x",
        id: '20"><script>alert(1)</script>',
        nonce: "abc",
        siteOrigin: SITE,
        theme: "light",
      }),
    ).toThrow();
  });

  it("lives under the path the site policy admits", () => {
    expect(shellPath("x", "20")).toBe("/embed/shell/x/20");
  });
});

describe("player messages", () => {
  it("encodes YouTube commands", () => {
    expect(JSON.parse(youtubeCommand("play"))).toEqual({
      event: "command",
      func: "playVideo",
      args: [],
      id: 1,
      channel: "widget",
    });
    expect(JSON.parse(youtubeCommand("unmute")).func).toBe("unMute");
  });

  it("decodes YouTube events", () => {
    expect(decodeYouTube('{"event":"onReady","id":1}')).toEqual([
      { type: "ready" },
    ]);
    expect(decodeYouTube('{"event":"onStateChange","info":1}')).toEqual([
      { type: "state", state: "playing" },
    ]);
    expect(
      decodeYouTube('{"event":"infoDelivery","info":{"playerState":2,"muted":true}}'),
    ).toEqual([
      { type: "state", state: "paused" },
      { type: "muted", muted: true },
    ]);
    expect(decodeYouTube('{"event":"onError","info":150}')).toEqual([
      { type: "error", detail: "150" },
    ]);
  });

  it("encodes and decodes TikTok's documented protocol", () => {
    expect(tiktokCommand("unmute")).toEqual({
      "x-tiktok-player": true,
      type: "unMute",
      value: undefined,
    });
    const event = (type: string, value?: unknown) =>
      decodeTikTok({ "x-tiktok-player": true, type, value });
    expect(event("onPlayerReady")).toEqual([{ type: "ready" }]);
    expect(event("onStateChange", 0)).toEqual([{ type: "state", state: "ended" }]);
    expect(event("onStateChange", 3)).toEqual([
      { type: "state", state: "buffering" },
    ]);
    expect(event("onMute", false)).toEqual([{ type: "muted", muted: false }]);
    expect(
      event("onPlayerError", { errorCode: 3002, errorType: "AUTOPLAY_ERROR" }),
    ).toEqual([{ type: "error", detail: "3002 AUTOPLAY_ERROR" }]);
  });

  it("ignores TikTok-shaped messages without the player marker", () => {
    expect(decodeTikTok({ type: "onPlayerReady" })).toEqual([]);
  });

  it("decodes height reports from X, Instagram, and the shell", () => {
    expect(
      decodeX({
        "twttr.embed": {
          method: "twttr.private.resize",
          params: [{ width: 550, height: 612.4 }],
        },
      }),
    ).toEqual([{ type: "height", height: 613 }]);
    expect(
      decodeInstagram('{"type":"MEASURE","details":{"height":740}}'),
    ).toEqual([{ type: "height", height: 740 }]);
    expect(decodeShell({ type: SHELL_HEIGHT_MESSAGE, height: 480 })).toEqual([
      { type: "height", height: 480 },
    ]);
  });

  it("caps reported heights and drops nonsense", () => {
    expect(decodeShell({ type: SHELL_HEIGHT_MESSAGE, height: 1e9 })).toEqual([
      { type: "height", height: 5000 },
    ]);
    for (const height of [0, -5, Number.NaN, "600", null]) {
      expect(decodeShell({ type: SHELL_HEIGHT_MESSAGE, height })).toEqual([]);
    }
  });

  it.each([
    undefined,
    null,
    42,
    "not json",
    "[]",
    "{}",
    { event: "somethingElse" },
    { "twttr.embed": { method: "twttr.private.trigger" } },
  ])("ignores unrecognized data %j", (data) => {
    for (const decode of [
      decodeYouTube,
      decodeTikTok,
      decodeX,
      decodeInstagram,
      decodeShell,
    ]) {
      expect(decode(data)).toEqual([]);
    }
  });
});

describe("connectEmbed", () => {
  let page: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new EventTarget();
    vi.stubGlobal("window", page);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function fakeFrame() {
    const contentWindow = { postMessage: vi.fn() };
    const frame = Object.assign(new EventTarget(), { contentWindow });
    return { frame: frame as unknown as HTMLIFrameElement, contentWindow };
  }

  function deliver(origin: string, source: unknown, data: unknown) {
    page.dispatchEvent(
      Object.assign(new Event("message"), { origin, source, data }),
    );
  }

  it("accepts messages only from the frame's own window and origin", () => {
    const { frame, contentWindow } = fakeFrame();
    const events: EmbedEvent[] = [];
    connectEmbed("tiktok", frame, { onEvent: (event) => events.push(event) });
    const ready = { "x-tiktok-player": true, type: "onPlayerReady" };

    deliver("https://evil.example", contentWindow, ready);
    deliver("https://www.tiktok.com", { postMessage: vi.fn() }, ready);
    deliver("null", contentWindow, ready);
    expect(events).toEqual([]);

    deliver("https://www.tiktok.com", contentWindow, ready);
    expect(events).toEqual([{ type: "ready" }]);
  });

  it("matches the opaque-origin shell by source window", () => {
    const { frame, contentWindow } = fakeFrame();
    const events: EmbedEvent[] = [];
    connectEmbed("shell", frame, { onEvent: (event) => events.push(event) });
    const height = { type: SHELL_HEIGHT_MESSAGE, height: 300 };

    deliver("null", { postMessage: vi.fn() }, height);
    deliver(SITE, contentWindow, height);
    expect(events).toEqual([]);

    deliver("null", contentWindow, height);
    expect(events).toEqual([{ type: "height", height: 300 }]);
  });

  it("sends commands to the provider's origin and nowhere else", () => {
    const { frame, contentWindow } = fakeFrame();
    const connection = connectEmbed("youtube", frame, { onEvent: () => {} });

    connection.send("pause");
    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      youtubeCommand("pause"),
      "https://www.youtube-nocookie.com",
    );
  });

  it("never posts into uncontrolled embeds or the shell", () => {
    for (const source of ["x", "instagram", "suno", "shell"] as const) {
      const { frame, contentWindow } = fakeFrame();
      const connection = connectEmbed(source, frame, { onEvent: () => {} });
      connection.send("play");
      vi.advanceTimersByTime(2000);
      expect(contentWindow.postMessage).not.toHaveBeenCalled();
    }
  });

  it("asks YouTube for events until it replies, then stops", () => {
    const { frame, contentWindow } = fakeFrame();
    connectEmbed("youtube", frame, { onEvent: () => {} });

    vi.advanceTimersByTime(750);
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(3);

    deliver("https://www.youtube-nocookie.com", contentWindow, '{"event":"onReady"}');
    vi.advanceTimersByTime(2000);
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(3);
  });

  it("stops listening once disconnected", () => {
    const { frame, contentWindow } = fakeFrame();
    const events: EmbedEvent[] = [];
    const connection = connectEmbed("tiktok", frame, {
      onEvent: (event) => events.push(event),
    });
    connection.disconnect();

    deliver("https://www.tiktok.com", contentWindow, {
      "x-tiktok-player": true,
      type: "onPlayerReady",
    });
    expect(events).toEqual([]);
  });
});

describe("detectInAppBrowser", () => {
  it.each([
    [
      "Instagram",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 335.0.0.31.93 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 606558403)",
    ],
    [
      "Instagram",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 Instagram 331.0.0.37.90 Android",
    ],
    [
      "Facebook",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBAV/465.0.0.39.106;FBBV/600000000;FBDV/iPhone15,2]",
    ],
    [
      "TikTok",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US BytedanceWebview/d8a21c6",
    ],
    [
      "X",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.50",
    ],
    [
      "this app",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36",
    ],
  ])("detects %s", (name, userAgent) => {
    expect(detectInAppBrowser(userAgent)).toBe(name);
  });

  it.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "",
  ])("leaves regular browsers alone: %j", (userAgent) => {
    expect(detectInAppBrowser(userAgent)).toBeNull();
  });
});
