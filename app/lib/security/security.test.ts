import { describe, expect, it } from "vitest";

import { frameUrl } from "../embeds/frames";
import { type MediaLink, PROVIDERS } from "../links/types";
import { readBodyCapped } from "./body";
import { buildSitePolicy, createNonce } from "./csp";
import { withSecurityHeaders } from "./headers";
import { isSameOriginRequest, returnHere, safeReturnPath } from "./request";

const SITE = "https://aion.ly";

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values];
    }),
  );
}

describe("createNonce", () => {
  it("returns a different base64 value each time", () => {
    const first = createNonce();
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(first);
  });
});

describe("buildSitePolicy", () => {
  const policy = directives(buildSitePolicy({ nonce: "abc" }));

  it("runs only first-party scripts and Turnstile", () => {
    expect(policy["script-src"]).toEqual([
      "'self'",
      "'nonce-abc'",
      "https://challenges.cloudflare.com",
    ]);
  });

  it("limits frames to the seven providers and Turnstile", () => {
    expect(policy["frame-src"]).toEqual([
      "https://www.youtube-nocookie.com",
      "https://www.tiktok.com",
      "https://suno.com",
      "https://w.soundcloud.com",
      "https://platform.twitter.com",
      "https://embed.reddit.com",
      "https://t.me",
      "https://challenges.cloudflare.com",
    ]);
  });

  it("never admits the site itself as a frame", () => {
    expect(policy["frame-src"]).not.toContain("'self'");
    const hosts = policy["frame-src"].filter((source) => /^https?:\/\//.test(source)).map((source) => new URL(source).host);
    expect(hosts).not.toContain(new URL(SITE).host);
  });

  it("forbids framing the site and rebasing its URLs", () => {
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
  });

  it("loads media from the bucket's domain, and opens the HMR socket only in development", () => {
    expect(policy["connect-src"]).toEqual(["'self'"]);
    const media = directives(buildSitePolicy({ nonce: "abc", mediaOrigin: "https://media.aion.ly" }));
    expect(media["img-src"]).toEqual(["'self'", "data:", "blob:", "https://media.aion.ly"]);
    expect(media["media-src"]).toEqual(["'self'", "blob:", "https://media.aion.ly"]);
    const dev = directives(buildSitePolicy({ nonce: "abc", dev: true }));
    expect(dev["connect-src"]).toEqual(["'self'", "ws:"]);
  });

  it("admits every frame URL the builder can produce", () => {
    const sources = policy["frame-src"];
    for (const provider of PROVIDERS) {
      const link: MediaLink = {
        kind: "media",
        provider,
        id: "abc123",
        canonicalKey: `${provider}:abc123`,
        aspect: "16:9",
        controlled: false,
        embedPath: "r/place/comments/abc123",
      };
      const url = new URL(frameUrl(link, { siteOrigin: SITE, theme: "dark" }));
      expect(sources).toContain(url.origin);
    }
  });
});

describe("withSecurityHeaders", () => {
  const options = { nonce: "abc", dev: false, indexable: true };

  it("sends the site policy and forbids framing on ordinary responses", () => {
    const response = withSecurityHeaders(
      new Request(`${SITE}/p/abc`),
      new Response("ok"),
      options,
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.has("X-Robots-Tag")).toBe(false);
  });

  it("overrides a policy set by a route", () => {
    const response = withSecurityHeaders(
      new Request(`${SITE}/p/abc`),
      new Response("ok", {
        headers: { "Content-Security-Policy": "default-src *" },
      }),
      options,
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
  });

  it("marks every response noindex outside production", () => {
    const response = withSecurityHeaders(
      new Request(`${SITE}/`),
      new Response("ok"),
      { ...options, indexable: false },
    );
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("omits HSTS over plain HTTP and preserves status and body", async () => {
    const response = withSecurityHeaders(
      new Request("http://localhost:5173/"),
      new Response("teapot", { status: 418 }),
      { ...options, dev: true },
    );
    expect(response.headers.has("Strict-Transport-Security")).toBe(false);
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
  });
});

describe("isSameOriginRequest", () => {
  const request = (method: string, origin?: string) =>
    new Request(`${SITE}/submit`, {
      method,
      headers: origin === undefined ? {} : { Origin: origin },
    });

  it("lets safe methods through without an Origin header", () => {
    expect(isSameOriginRequest(request("GET"))).toBe(true);
    expect(isSameOriginRequest(request("HEAD"))).toBe(true);
  });

  it("accepts writes from the site itself", () => {
    expect(isSameOriginRequest(request("POST", SITE))).toBe(true);
    expect(isSameOriginRequest(request("DELETE", SITE))).toBe(true);
  });

  it.each([
    ["a missing Origin", undefined],
    ["another site", "https://evil.example"],
    ["an opaque origin", "null"],
    ["a subdomain", "https://dev.aion.ly"],
    ["a different scheme", "http://aion.ly"],
    ["a lookalike host", "https://aion.ly.evil.example"],
  ])("rejects writes with %s", (_label, origin) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSameOriginRequest(request(method, origin))).toBe(false);
    }
  });
});

describe("safeReturnPath", () => {
  it("keeps a same-origin path with its query and fragment", () => {
    expect(safeReturnPath("/p/abc?sort=top#c-9", SITE)).toBe(
      "/p/abc?sort=top#c-9",
    );
  });

  it.each([
    null,
    undefined,
    "",
    "p/abc",
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    // Paths that come to start `//` once their dot segments resolve (review F125).
    "/a/..//evil.example/landing",
    "/%2e%2e//evil.example/landing",
    "/a/%2E%2E//evil.example",
    "/.//evil.example",
    "/%2e//evil.example",
  ])("falls back to / for %j", (value) => {
    expect(safeReturnPath(value, SITE)).toBe("/");
  });

  it("unwraps a sign-in page to where it returns, however deeply nested, and never returns to signing out", () => {
    const nest = (inner: string, times: number) => {
      let path = inner;
      for (let n = 0; n < times; n += 1) path = `/signin?${new URLSearchParams({ next: path })}`;
      return path;
    };
    expect(safeReturnPath(nest("/p/abc?sort=top", 1), SITE)).toBe("/p/abc?sort=top");
    expect(safeReturnPath(nest("/p/abc", 16), SITE)).toBe("/p/abc");
    expect(safeReturnPath(nest("/p/abc", 40), SITE)).toBe("/");
    expect(safeReturnPath(`/signin/email?${new URLSearchParams({ next: "/settings" })}`, SITE)).toBe("/settings");
    expect(safeReturnPath("/signin?tab=member", SITE)).toBe("/");
    expect(safeReturnPath(nest("//evil.example", 3), SITE)).toBe("/");
    for (const depth of [1, 3, 16]) {
      expect(safeReturnPath(nest("/a/..//evil.example/landing", depth), SITE)).toBe("/");
      expect(safeReturnPath(nest("/%2e%2e//evil.example/landing", depth), SITE)).toBe("/");
    }
    expect(safeReturnPath("/signout", SITE)).toBe("/");
    expect(safeReturnPath("/SignOut/", SITE)).toBe("/");
    // Only the sign-in pages themselves.
    expect(safeReturnPath("/signing-off", SITE)).toBe("/signing-off");
  });

  it("knows the sign-in page by any address the router serves it at (review F127)", () => {
    const nestAt = (page: string, inner: string, times: number) => {
      let path = inner;
      for (let n = 0; n < times; n += 1) path = `${page}?${new URLSearchParams({ next: path })}`;
      return path;
    };
    for (const page of ["/SIGNIN", "/%73ignin", "/SignIn/", "/%53IGNIN/email"]) {
      expect(safeReturnPath(nestAt(page, "/p/abc", 1), SITE)).toBe("/p/abc");
      expect(safeReturnPath(nestAt(page, "/p/abc", 21), SITE)).toBe("/");
    }
    // A malformed escape is no sign-in page, and still a path on this site.
    expect(safeReturnPath("/%E0%A4%A", SITE)).toBe("/%E0%A4%A");
  });

  it("makes a sign-in page's own links return where it does, never nesting it", () => {
    expect(returnHere("/p/abc", "?sort=top")).toBe("/p/abc?sort=top");
    expect(returnHere("/signin", `?${new URLSearchParams({ next: "/p/abc", tab: "member" })}`)).toBe("/p/abc");
    expect(returnHere("/signin", `?${new URLSearchParams({ next: "/signin?next=%2Fp%2Fabc" })}`)).toBe("/p/abc");
    expect(returnHere("/SIGNIN", `?${new URLSearchParams({ next: "/p/abc" })}`)).toBe("/p/abc");
    expect(returnHere("/signin", "")).toBe("/");
  });

  it.each([
    "https://evil.example/login",
    "//evil.example/login",
    "http://[",
    "/a/..//evil.example/landing",
  ])("gives a sign-in page's links / for the destination %j it refuses (review F126)", (next) => {
    expect(returnHere("/signin", `?${new URLSearchParams({ next })}`)).toBe("/");
  });
});

describe("capped body reading", () => {
  /** A request whose body streams `chunks` of 1 KB, with no declared length, counting what was read. */
  function streamed(chunks: number) {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks) return controller.close();
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(97));
      },
    });
    const request = new Request("https://board.test/x", { method: "POST", body, duplex: "half" } as RequestInit);
    return { request, pulled: () => pulled };
  }

  it("reads a body within the limit", async () => {
    const { request } = streamed(2);
    expect(await readBodyCapped(request, 4096)).toBe("a".repeat(2048));
  });

  it("stops reading as soon as an undeclared body passes the limit", async () => {
    const { request, pulled } = streamed(2048);
    expect(await readBodyCapped(request, 2048)).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(4);
  });

  it("refuses a declared length over the limit without reading", async () => {
    const request = new Request("https://board.test/x", { method: "POST", body: "x".repeat(10), headers: { "Content-Length": "999999" } });
    expect(await readBodyCapped(request, 2048)).toBeNull();
  });
});
