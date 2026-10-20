import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDuration } from "../format";
import { detectInAppBrowser } from "../in-app-browser";
import { type MediaLink, PROVIDERS, type Provider } from "../links/types";
import { connectEmbed } from "./connect";
import { FRAME_LAYOUT, FRAME_ORIGINS, FRAME_SANDBOX, frameHeight, frameUrl } from "./frames";
import {
  decodeReddit,
  decodeTelegram,
  decodeTikTok,
  decodeX,
  decodeYouTube,
  type EmbedEvent,
  PLAYER_COMMANDS,
  tiktokCommand,
  youtubeCommand,
} from "./messages";

const SITE = "https://aion.ly";

function link(provider: Provider, id: string, embedPath?: string): MediaLink {
  return {
    kind: "media",
    provider,
    id,
    canonicalKey: `${provider}:${id}`,
    aspect: "16:9",
    controlled: provider === "youtube" || provider === "tiktok",
    embedPath,
  };
}

const REDDIT = link("reddit", "tqbguc", "r/place/comments/tqbguc");

describe("frameUrl", () => {
  const dark = { siteOrigin: SITE, theme: "dark" as const };
  const light = { siteOrigin: SITE, theme: "light" as const };

  it("builds the frame for each provider from its ID", () => {
    expect(frameUrl(link("youtube", "dQw4w9WgXcQ"), dark)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&origin=https%3A%2F%2Faion.ly&playsinline=1&rel=0&iv_load_policy=3",
    );
    expect(frameUrl(link("tiktok", "6718335390845095173"), dark)).toBe(
      "https://www.tiktok.com/player/v1/6718335390845095173?autoplay=1&controls=1&rel=0&music_info=0&description=0",
    );
    expect(
      frameUrl(link("suno", "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"), dark),
    ).toBe(
      "https://suno.com/embed/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d?theme=dark",
    );
    expect(frameUrl(link("x", "20"), dark)).toBe(
      "https://platform.twitter.com/embed/Tweet.html?id=20&theme=dark&dnt=true&hideThread=true",
    );
    expect(frameUrl(REDDIT, dark)).toBe(
      "https://embed.reddit.com/r/place/comments/tqbguc/?embed=true&style=subreddit-first&theme=dark",
    );
    expect(frameUrl(link("telegram", "telegram/83"), dark)).toBe(
      "https://t.me/telegram/83?embed=1&userpic=false&dark=1",
    );
  });

  it("follows the site theme wherever the provider has one", () => {
    expect(frameUrl(link("x", "20"), light)).toContain("theme=light");
    expect(frameUrl(link("suno", "abc"), light)).toContain("theme=light");
    // Light is the default for Reddit and Telegram; each only has a dark switch.
    expect(frameUrl(REDDIT, light)).toBe(
      "https://embed.reddit.com/r/place/comments/tqbguc/?embed=true&style=subreddit-first",
    );
    expect(frameUrl(link("telegram", "telegram/83"), light)).toBe(
      "https://t.me/telegram/83?embed=1&userpic=false",
    );
  });

  it("uses Reddit's compact layout", () => {
    expect(new URL(frameUrl(REDDIT, dark)).searchParams.get("style")).toBe(
      "subreddit-first",
    );
  });

  it("starts YouTube muted for the card in focus, with sound after a tap", () => {
    const focus = new URL(
      frameUrl(link("youtube", "dQw4w9WgXcQ"), { ...dark, autoplay: "muted" }),
    );
    expect(focus.searchParams.get("autoplay")).toBe("1");
    expect(focus.searchParams.get("mute")).toBe("1");

    const tap = new URL(
      frameUrl(link("youtube", "dQw4w9WgXcQ"), { ...dark, autoplay: "sound" }),
    );
    expect(tap.searchParams.get("autoplay")).toBe("1");
    expect(tap.searchParams.has("mute")).toBe(false);
  });

  it("always starts TikTok playing and never locks its volume", () => {
    for (const autoplay of [undefined, "muted", "sound"] as const) {
      const url = new URL(
        frameUrl(link("tiktok", "6718335390845095173"), { ...dark, autoplay }),
      );
      expect(url.searchParams.get("autoplay")).toBe("1");
      // `muted=1` would stop the viewer from ever turning the sound on.
      expect(url.searchParams.has("muted")).toBe(false);
    }
  });

  it("asks SoundCloud for its classic player, a playlist's with its tracks below", () => {
    const track = new URL(frameUrl(link("soundcloud", "forss/flickermood"), dark));
    expect(track.origin + track.pathname).toBe("https://w.soundcloud.com/player/");
    expect(Object.fromEntries(track.searchParams)).toEqual({
      url: "https://soundcloud.com/forss/flickermood",
      visual: "false",
      auto_play: "false",
      hide_related: "true",
      show_comments: "false",
      show_reposts: "false",
      show_teaser: "false",
      show_artwork: "false",
    });
    expect(frameHeight(link("soundcloud", "forss/flickermood"))).toBe(166);
    expect(frameHeight(link("soundcloud", "forss/sets/soulhack"))).toBe(300);
    expect(frameHeight(link("suno", "abc"))).toBe(176);
  });

  it("cannot be steered off the provider by a hand-built ID or path", () => {
    for (const id of ["../../evil", "forss/flickermood?x=1", "https://evil.example/a", "forss/sets/a/b"]) {
      const soundcloud = new URL(frameUrl(link("soundcloud", id), dark));
      expect(soundcloud.origin).toBe("https://w.soundcloud.com");
      expect(soundcloud.searchParams.get("url"), id).toBe("https://soundcloud.com/-");
    }

    const suno = new URL(frameUrl(link("suno", "../../evil?x=1#y"), dark));
    expect(suno.origin).toBe("https://suno.com");
    expect(suno.pathname).toBe("/embed/..%2F..%2Fevil%3Fx%3D1%23y");

    for (const path of ["r/a?b=1#c/comments/x", "r/place/comments/../../x", ""]) {
      const reddit = new URL(frameUrl(link("reddit", "tqbguc", path), dark));
      expect(reddit.origin).toBe("https://embed.reddit.com");
      expect(reddit.pathname).toBe("/comments/tqbguc/");
      expect(reddit.searchParams.get("embed")).toBe("true");
    }

    const telegram = new URL(
      frameUrl(link("telegram", "telegram/83/../../evil?x=1"), dark),
    );
    expect(telegram.origin).toBe("https://t.me");
    expect(telegram.pathname).toBe("/telegram%2F83%2F..%2F..%2Fevil%3Fx%3D1");
    expect(telegram.searchParams.get("embed")).toBe("1");
  });

  it("stays on the origin the policy allows for every provider", () => {
    for (const provider of PROVIDERS) {
      const url = new URL(
        frameUrl(link(provider, "abc", "r/place/comments/abc"), dark),
      );
      expect(url.origin).toBe(FRAME_ORIGINS[provider]);
    }
  });

  it("never lets a frame navigate the top window", () => {
    expect(FRAME_SANDBOX).not.toContain("allow-top-navigation");
  });

  it("marks only transparent, light-only documents for the light scheme", () => {
    expect(FRAME_LAYOUT.x).toMatchObject({ maxWidth: 550, lightScheme: true });
    expect(FRAME_LAYOUT.reddit.maxWidth).toBe(640);
    expect(FRAME_LAYOUT.telegram.maxWidth).toBe(500);
    // Telegram lays out no narrower than this; the frame is scaled to fit.
    expect(FRAME_LAYOUT.telegram.minWidth).toBe(320);
    // Telegram draws its own bubble, tail included, so its frame is not rounded.
    expect(FRAME_LAYOUT.telegram.ownOutline).toBe(true);
    expect(FRAME_LAYOUT.reddit.ownOutline).toBeUndefined();
    expect(FRAME_LAYOUT.youtube.lightScheme).toBeUndefined();
  });

  it("keeps every self-sizing embed from scrolling inside its frame", () => {
    for (const provider of ["x", "reddit", "telegram"] as const) {
      expect(FRAME_LAYOUT[provider].selfSizing).toBe(true);
    }
    for (const provider of ["youtube", "tiktok", "suno", "soundcloud"] as const) {
      expect(FRAME_LAYOUT[provider].selfSizing).toBeUndefined();
    }
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
    expect(tiktokCommand("pause")).toEqual({
      "x-tiktok-player": true,
      type: "pause",
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
      event("onPlayerError", { errorCode: 2004, errorType: "VIDEO_UNAVAILABLE" }),
    ).toEqual([{ type: "error", detail: "2004 VIDEO_UNAVAILABLE" }]);
    // Autoplay refused, as on an iPhone in Low Power Mode, is no failure.
    expect(
      event("onPlayerError", { errorCode: 3002, errorType: "AUTOPLAY_ERROR" }),
    ).toEqual([{ type: "refused" }]);
  });

  it("ignores TikTok-shaped messages without the player marker", () => {
    expect(decodeTikTok({ type: "onPlayerReady" })).toEqual([]);
  });

  it("decodes Telegram's height reports and nothing else it sends", () => {
    expect(decodeTelegram('{"event":"resize","height":384}')).toEqual([
      { type: "height", height: 384 },
    ]);
    // The frame also asks its host to scroll the page; that is never honored.
    for (const data of [
      '{"event":"ready"}',
      '{"event":"scroll_to","x":0,"y":900}',
      '{"event":"get_coords","_cb":1}',
    ]) {
      expect(decodeTelegram(data)).toEqual([]);
    }
  });

  it("decodes height reports from X and Reddit", () => {
    expect(
      decodeX({
        "twttr.embed": {
          method: "twttr.private.resize",
          params: [{ width: 550, height: 612.4 }],
        },
      }),
    ).toEqual([{ type: "height", height: 613 }]);
    expect(decodeReddit('{"type":"resize.embed","data":479}')).toEqual([
      { type: "height", height: 479 },
    ]);
  });

  it("caps reported heights and drops nonsense", () => {
    expect(decodeReddit('{"type":"resize.embed","data":1000000000}')).toEqual([
      { type: "height", height: 5000 },
    ]);
    for (const data of [0, -5, null, "600"]) {
      expect(decodeReddit({ type: "resize.embed", data })).toEqual([]);
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
    { type: "MEASURE", details: { height: 700 } },
    { "twttr.embed": { method: "twttr.private.trigger" } },
  ])("ignores unrecognized data %j", (data) => {
    for (const decode of [
      decodeYouTube,
      decodeTikTok,
      decodeX,
      decodeReddit,
      decodeTelegram,
    ]) {
      expect(decode(data)).toEqual([]);
    }
  });

  it("offers mute commands only where the player keeps to them", () => {
    expect(PLAYER_COMMANDS.youtube).toEqual(["play", "pause", "mute", "unmute"]);
    expect(PLAYER_COMMANDS.tiktok).toEqual(["play", "pause"]);
    for (const provider of ["suno", "soundcloud", "x", "reddit", "telegram"] as const) {
      expect(PLAYER_COMMANDS[provider]).toEqual([]);
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

  it("sizes a Reddit post from Reddit's frame alone", () => {
    const { frame, contentWindow } = fakeFrame();
    const events: EmbedEvent[] = [];
    connectEmbed("reddit", frame, { onEvent: (event) => events.push(event) });
    const resize = '{"type":"resize.embed","data":479}';

    deliver("https://www.reddit.com", contentWindow, resize);
    deliver("https://platform.twitter.com", contentWindow, resize);
    expect(events).toEqual([]);

    deliver("https://embed.reddit.com", contentWindow, resize);
    expect(events).toEqual([{ type: "height", height: 479 }]);
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

  it("does not send TikTok the mute commands it would undo", () => {
    const { frame, contentWindow } = fakeFrame();
    const connection = connectEmbed("tiktok", frame, { onEvent: () => {} });

    connection.send("mute");
    connection.send("unmute");
    expect(contentWindow.postMessage).not.toHaveBeenCalled();

    connection.send("pause");
    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      tiktokCommand("pause"),
      "https://www.tiktok.com",
    );
  });

  it("never posts into uncontrolled embeds", () => {
    for (const provider of ["suno", "soundcloud", "x", "reddit", "telegram"] as const) {
      const { frame, contentWindow } = fakeFrame();
      const connection = connectEmbed(provider, frame, { onEvent: () => {} });
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

describe("formatDuration", () => {
  it("formats media lengths", () => {
    expect([0, 7, 42, 187, 3600, 3723].map(formatDuration)).toEqual([
      "0:00",
      "0:07",
      "0:42",
      "3:07",
      "1:00:00",
      "1:02:03",
    ]);
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
