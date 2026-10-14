import { test as base, expect } from "@playwright/test";

export interface PageProblems {
  /** Console errors and uncaught exceptions. */
  errors: string[];
  /** Content Security Policy violations reported in the top document. */
  violations: string[];
}

/**
 * Stand-ins for the controlled players and one self-sizing embed. Each speaks
 * the same messages as the real frame and records the commands it receives,
 * so playback can be tested without a provider.
 */
const FAKE_FRAMES: Array<{ match: RegExp; script: string }> = [
  {
    match: /^https:\/\/www\.youtube-nocookie\.com\/embed\//,
    script: `
      const params = new URL(location.href).searchParams;
      let state = params.get("autoplay") === "1" ? 1 : -1;
      let muted = params.get("mute") === "1";
      window.commands = [];
      const send = (message) =>
        parent.postMessage(JSON.stringify({ ...message, id: 1, channel: "widget" }), "*");
      const deliver = () => send({ event: "infoDelivery", info: { playerState: state, muted } });
      const change = (next) => {
        state = next;
        send({ event: "onStateChange", info: state });
        deliver();
      };
      window.player = () => ({ playing: state === 1, muted });
      window.viewerPlay = () => change(1);
      window.viewerPause = () => change(2);
      window.viewerUnmute = () => { muted = false; deliver(); };
      addEventListener("message", (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.event === "listening") {
          send({ event: "onReady" });
          deliver();
          return;
        }
        if (data.event !== "command") return;
        window.commands.push(data.func);
        if (data.func === "playVideo") change(1);
        if (data.func === "pauseVideo") change(2);
        if (data.func === "mute") { muted = true; deliver(); }
        if (data.func === "unMute") { muted = false; deliver(); }
      });
    `,
  },
  {
    match: /^https:\/\/www\.tiktok\.com\/player\/v1\//,
    script: `
      // TikTok's player starts playing, muted, as it loads.
      let state = 1;
      window.commands = [];
      const send = (type, value) =>
        parent.postMessage({ "x-tiktok-player": true, type, value }, "*");
      window.player = () => ({ playing: state === 1 });
      setTimeout(() => {
        send("onPlayerReady");
        send("onMute", true);
        send("onStateChange", 1);
      }, 50);
      addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data["x-tiktok-player"] !== true) return;
        window.commands.push(data.type);
        if (data.type === "play") { state = 1; send("onStateChange", 1); }
        if (data.type === "pause") { state = 2; send("onStateChange", 2); }
      });
    `,
  },
  {
    match: /^https:\/\/platform\.twitter\.com\/embed\/Tweet\.html/,
    script: `
      setTimeout(() => parent.postMessage(
        { "twttr.embed": { method: "twttr.private.resize", params: [{ height: 260 }] } },
        "*",
      ), 50);
    `,
  },
];

/**
 * Every test runs offline from third parties: requests that leave the app are
 * answered locally, with an empty page or, when `fakePlayers` is on, a stand-in
 * player. Nothing depends on a provider being up and no test traffic reaches
 * one. Problems the page reports are collected for assertions.
 */
export const test = base.extend<{
  fakePlayers: boolean;
  thirdParties: void;
  problems: PageProblems;
}>({
  fakePlayers: [false, { option: true }],

  thirdParties: [
    async ({ page, baseURL, fakePlayers }, use) => {
      const appOrigin = new URL(baseURL!).origin;
      await page.route(
        (url) => url.origin !== appOrigin && url.protocol.startsWith("http"),
        (route) => {
          const url = route.request().url();
          const fake = fakePlayers
            ? FAKE_FRAMES.find((frame) => frame.match.test(url))
            : undefined;
          return route.fulfill({
            status: 200,
            contentType: "text/html",
            body: fake ? `<!doctype html><script>${fake.script}</script>` : "",
          });
        },
      );
      await use();
    },
    { auto: true },
  ],

  problems: async ({ page }, use) => {
    const problems: PageProblems = { errors: [], violations: [] };

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) {
        problems.violations.push(text);
      } else {
        problems.errors.push(text);
      }
    });
    page.on("pageerror", (error) => problems.errors.push(String(error)));

    await use(problems);
  },
});

export { expect };
