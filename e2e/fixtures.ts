import { readFileSync } from "node:fs";

import { type APIRequestContext, test as base, type BrowserContext, expect, type Page } from "@playwright/test";

import { ACCOUNTS_PER_WORKER, ADMIN_ACCOUNT, APPEAL_ACCOUNT, BANNED_ACCOUNT, DAY_OLD_ACCOUNT, LOW_KARMA_ACCOUNT, MAX_WORKERS } from "./accounts";

export interface PageProblems {
  /** Console errors and uncaught exceptions. */
  errors: string[];
  /** Content Security Policy violations reported in the top document. */
  violations: string[];
}

/**
 * Stand-ins for the controlled players, a song player, and one self-sizing
 * embed. Each speaks
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
      // As YouTube's own play button does: buffering first, then playing,
      // unless a pause comes while it loads.
      let loading;
      window.viewerPlay = () => {
        change(3);
        loading = setTimeout(() => change(1), 300);
      };
      window.viewerPause = () => change(2);
      window.viewerUnmute = () => { muted = false; deliver(); };
      // As YouTube reports a video that cannot be embedded (150).
      window.viewerFail = () => send({ event: "onError", info: 150 });
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
        if (data.func === "pauseVideo") { clearTimeout(loading); change(2); }
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
    // Suno's player takes no commands; the viewer plays it in its own button.
    match: /^https:\/\/suno\.com\/embed\//,
    script: `
      let playing = false;
      window.player = () => ({ playing });
      const button = document.createElement("button");
      button.textContent = "Play";
      button.onclick = () => { playing = true; };
      addEventListener("DOMContentLoaded", () => document.body.append(button));
    `,
  },
  {
    // SoundCloud's player, likewise, in this board's use of it.
    match: /^https:\/\/w\.soundcloud\.com\/player\//,
    script: `
      let playing = false;
      window.player = () => ({ playing });
      const button = document.createElement("button");
      button.textContent = "Play";
      button.onclick = () => { playing = true; };
      addEventListener("DOMContentLoaded", () => document.body.append(button));
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

/** Opens a page and waits until its scripts run, so every control works. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
}

export interface TestAccount {
  id: string;
  username: string;
  /** Signs the browser context in as this account. */
  signIn: (context: BrowserContext) => Promise<void>;
}

/**
 * A secret of the test server's. The build copies the local secrets into its
 * output, wherever they came from, quoted.
 */
export function serverSecret(name: string): string {
  const vars = readFileSync(new URL("../build/server/.dev.vars", import.meta.url), "utf8");
  const match = new RegExp(`^${name}=(['"\`]?)(.*)\\1$`, "m").exec(vars);
  if (!match) throw new Error(`${name} is missing from build/server/.dev.vars; see .dev.vars.example`);
  return match[2];
}

/** The secret the test server signs session cookies with. */
const authSecret = () => serverSecret("BETTER_AUTH_SECRET");

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Buffer.from(mac).toString("hex");
}

/**
 * Gives an account the Fan plan the way Stripe does: a signed webhook
 * saying its subscription is active for a month, or with `status`, that it
 * changed; billed monthly, or yearly with `interval`; with `ending`, set to
 * end at the period's close, as cancelling does. Nothing reaches Stripe.
 */
export async function setPlan(
  request: APIRequestContext,
  account: TestAccount,
  status: "active" | "canceled" = "active",
  interval: "month" | "year" = "month",
  ending = false,
  /** A switch to the other interval, asked for, made at the period's end. */
  switching = false,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const end = now + (interval === "year" ? 365 : 30) * 24 * 3600;
  const key = (of: "month" | "year") => (of === "year" ? "aionly_fan_yearly" : "aionly_fan_monthly");
  const other = interval === "year" ? "month" : "year";
  const payload = JSON.stringify({
    id: `evt_${account.id}_${status}_${interval}${ending ? "_ending" : ""}${switching ? "_switching" : ""}`,
    type: status === "active" ? "customer.subscription.created" : "customer.subscription.deleted",
    created: now,
    data: {
      object: {
        id: `sub_${account.id}`,
        object: "subscription",
        customer: `cus_${account.id}`,
        status,
        cancel_at_period_end: ending,
        metadata: { user_id: account.id },
        schedule: switching
          ? {
              id: `sub_sched_${account.id}`,
              metadata: { aionly: "plan_switch" },
              current_phase: { start_date: now, end_date: end },
              phases: [
                { start_date: now, end_date: end, items: [{ price: { id: "price_e2e", lookup_key: key(interval) }, quantity: 1 }] },
                { start_date: end, end_date: end + 365 * 24 * 3600, items: [{ price: { id: "price_e2e_next", lookup_key: key(other) }, quantity: 1 }] },
              ],
            }
          : null,
        items: {
          data: [
            {
              current_period_end: end,
              price: { id: "price_e2e", lookup_key: key(interval), recurring: { interval } },
            },
          ],
        },
      },
    },
  });
  const signature = `t=${now},v1=${await hmacHex(serverSecret("STRIPE_WEBHOOK_SECRET"), `${now}.${payload}`)}`;
  const response = await request.post("/api/stripe", {
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    data: payload,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Pays for a fresh start the way Stripe reports it: a signed webhook that a
 * checkout for one was completed and paid. Nothing reaches Stripe.
 */
export async function payFreshStart(request: APIRequestContext, account: TestAccount): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: `evt_fresh_${account.id}`,
    type: "checkout.session.completed",
    created: now,
    data: {
      object: {
        id: `cs_fresh_${account.id}`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        client_reference_id: account.id,
        metadata: { user_id: account.id, kind: "fresh_start", start_now_requested_at: String(now) },
      },
    },
  });
  const signature = `t=${now},v1=${await hmacHex(serverSecret("STRIPE_WEBHOOK_SECRET"), `${now}.${payload}`)}`;
  const response = await request.post("/api/stripe", {
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    data: payload,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Buys the Short username package the way Stripe reports it: a signed webhook
 * that a checkout for it alone was completed and paid. Nothing reaches
 * Stripe.
 */
export async function buyName(request: APIRequestContext, account: TestAccount): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: `evt_name_${account.id}`,
    type: "checkout.session.completed",
    created: now,
    data: {
      object: {
        id: `cs_name_${account.id}`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        client_reference_id: account.id,
        currency: "usd",
        metadata: { user_id: account.id, kind: "name_allowance", name_length: "4", name_cents: "25000", start_now_requested_at: String(now) },
      },
    },
  });
  const signature = `t=${now},v1=${await hmacHex(serverSecret("STRIPE_WEBHOOK_SECRET"), `${now}.${payload}`)}`;
  const response = await request.post("/api/stripe", {
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    data: payload,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** A session cookie value as Better Auth signs it: `token.HMAC`, URL-encoded. */
async function signedToken(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return encodeURIComponent(`${token}.${Buffer.from(signature).toString("base64")}`);
}

function testAccount(id: string, username: string, baseURL: string): TestAccount {
  return {
    id,
    username,
    signIn: async (context) => {
      await context.addCookies([
        {
          name: "better-auth.session_token",
          value: await signedToken(`e2e-session-${id}`),
          url: baseURL,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    },
  };
}

// Each test in a worker takes the next unused account, so tests never share
// one and can change it freely. See scripts/e2e-accounts.ts.
let accountsTaken = 0;

function nextAccount(baseURL: string, workerIndex: number): TestAccount {
  if (accountsTaken >= ACCOUNTS_PER_WORKER || workerIndex >= MAX_WORKERS) {
    throw new Error("out of test accounts: raise the counts in e2e/accounts.ts");
  }
  // The worker index is unique over the whole run, so no two workers,
  // even one replacing another, hand out the same account.
  const n = workerIndex * ACCOUNTS_PER_WORKER + accountsTaken;
  accountsTaken += 1;
  return testAccount(`e2e${n}`, `e2e_user_${n}`, baseURL);
}

/**
 * Turnstile's script, standing in for Cloudflare's: it shows a box and passes
 * at once with the token Cloudflare's test keys produce.
 */
const FAKE_TURNSTILE = `
  window.turnstile = {
    render(element, options) {
      window.turnstileOptions = options;
      const box = document.createElement("div");
      box.textContent = "Turnstile stand-in";
      element.appendChild(box);
      setTimeout(() => options.callback("XXXX.DUMMY.TOKEN.XXXX"), 50);
      return "stand-in-" + Math.random();
    },
    remove() {},
  };
`;

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
  /** A fresh account of the test's own, not yet signed in. */
  account: TestAccount;
  /** A second fresh account, for what one account does to another's. */
  otherAccount: TestAccount;
  /** One more fresh account at each call, for a test that needs several. */
  newAccount: () => TestAccount;
  /** An account under a permanent ban, shared by every test. */
  bannedAccount: TestAccount;
  /** Made 30 hours ago, past the offer's 24 hours; shared, so only read. */
  dayOldAccount: TestAccount;
  /** The admin, shared by every test that moderates. */
  adminAccount: TestAccount;
  /** This worker's account below the karma floor, at -120. */
  lowKarmaAccount: TestAccount;
  /** This worker's other account below the floor, at -130, for an appeal. */
  appealAccount: TestAccount;
}>({
  fakePlayers: [false, { option: true }],

  account: async ({ baseURL }, use, testInfo) => {
    await use(nextAccount(baseURL!, testInfo.workerIndex));
  },

  otherAccount: async ({ baseURL }, use, testInfo) => {
    await use(nextAccount(baseURL!, testInfo.workerIndex));
  },

  newAccount: async ({ baseURL }, use, testInfo) => {
    await use(() => nextAccount(baseURL!, testInfo.workerIndex));
  },

  adminAccount: async ({ baseURL }, use) => {
    await use(testAccount(ADMIN_ACCOUNT, "e2e_admin", baseURL!));
  },

  bannedAccount: async ({ baseURL }, use) => {
    await use(testAccount(BANNED_ACCOUNT, "e2e_banned", baseURL!));
  },

  dayOldAccount: async ({ baseURL }, use) => {
    await use(testAccount(DAY_OLD_ACCOUNT, "e2e_day_old", baseURL!));
  },

  lowKarmaAccount: async ({ baseURL }, use, testInfo) => {
    await use(testAccount(`${LOW_KARMA_ACCOUNT}${testInfo.workerIndex}`, `e2e_low_${testInfo.workerIndex}`, baseURL!));
  },

  appealAccount: async ({ baseURL }, use, testInfo) => {
    await use(testAccount(`${APPEAL_ACCOUNT}${testInfo.workerIndex}`, `e2e_appeal_${testInfo.workerIndex}`, baseURL!));
  },

  thirdParties: [
    async ({ page, baseURL, fakePlayers }, use) => {
      const appOrigin = new URL(baseURL!).origin;
      await page.route(
        (url) => url.origin !== appOrigin && url.protocol.startsWith("http"),
        (route) => {
          const url = route.request().url();
          if (url.startsWith("https://challenges.cloudflare.com/turnstile/")) {
            return route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: FAKE_TURNSTILE,
            });
          }
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
