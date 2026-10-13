import { describe, expect, it } from "vitest";

import { FRAME_ORIGINS, frameUrl, shellPath } from "../embeds/frames";
import type { MediaLink } from "../links/types";
import { buildShellPolicy, buildSitePolicy, createNonce } from "./csp";
import { withSecurityHeaders } from "./headers";
import { isSameOriginRequest, safeReturnPath } from "./request";

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
  const policy = directives(buildSitePolicy({ nonce: "abc", siteOrigin: SITE }));

  it("runs only first-party scripts and Turnstile", () => {
    expect(policy["script-src"]).toEqual([
      "'self'",
      "'nonce-abc'",
      "https://challenges.cloudflare.com",
    ]);
  });

  it("limits frames to the five providers, Turnstile, and the shell path", () => {
    expect(policy["frame-src"]).toEqual([
      "https://www.youtube-nocookie.com",
      "https://www.tiktok.com",
      "https://suno.com",
      "https://www.instagram.com",
      "https://platform.twitter.com",
      "https://challenges.cloudflare.com",
      "https://aion.ly/embed/shell/",
    ]);
  });

  it("forbids framing the site and rebasing its URLs", () => {
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
  });

  it("opens the HMR socket only in development", () => {
    expect(policy["connect-src"]).toEqual(["'self'"]);
    const dev = directives(
      buildSitePolicy({ nonce: "abc", siteOrigin: SITE, dev: true }),
    );
    expect(dev["connect-src"]).toEqual(["'self'", "ws:"]);
  });

  it("admits every frame URL the builder can produce", () => {
    const sources = policy["frame-src"];
    for (const provider of Object.keys(FRAME_ORIGINS) as MediaLink["provider"][]) {
      const link: MediaLink = {
        kind: "media",
        provider,
        id: "abc123",
        canonicalKey: `${provider}:abc123`,
        aspect: "16:9",
        controlled: false,
      };
      const url = new URL(frameUrl(link, { siteOrigin: SITE, theme: "dark" }));
      expect(sources).toContain(url.origin);
    }
  });

  it("admits the embed shell path", () => {
    const shell = new URL(shellPath("x", "20"), SITE).href;
    const source = policy["frame-src"].find((value) => value.startsWith(SITE));
    expect(source).toBeDefined();
    expect(shell.startsWith(source!)).toBe(true);
  });
});

describe("buildShellPolicy", () => {
  const policy = directives(
    buildShellPolicy({ nonce: "abc", siteOrigin: SITE, provider: "x" }),
  );

  it("sandboxes the shell at an opaque origin", () => {
    expect(policy.sandbox).toEqual([
      "allow-scripts",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
    ]);
    expect(policy.sandbox).not.toContain("allow-same-origin");
    expect(policy.sandbox).not.toContain("allow-top-navigation");
  });

  it("allows only the nonce and that provider's script and frame hosts", () => {
    expect(policy["default-src"]).toEqual(["'none'"]);
    expect(policy["script-src"]).toEqual([
      "'nonce-abc'",
      "https://platform.twitter.com",
    ]);
    expect(policy["frame-src"]).toEqual(["https://platform.twitter.com"]);
  });

  it("can be framed only by the site", () => {
    expect(policy["frame-ancestors"]).toEqual([SITE]);
  });

  it("scopes Instagram to Instagram", () => {
    const instagram = directives(
      buildShellPolicy({ nonce: "abc", siteOrigin: SITE, provider: "instagram" }),
    );
    expect(instagram["script-src"]).toEqual([
      "'nonce-abc'",
      "https://www.instagram.com",
    ]);
    expect(instagram["frame-src"]).toEqual(["https://www.instagram.com"]);
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

  it("overrides a policy set by any route other than the shell", () => {
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

  it("keeps the embed shell's own policy and lets the site frame it", () => {
    const shellPolicy = buildShellPolicy({
      nonce: "abc",
      siteOrigin: SITE,
      provider: "x",
    });
    const response = withSecurityHeaders(
      new Request(`${SITE}${shellPath("x", "20")}`),
      new Response("<!doctype html>", {
        headers: { "Content-Security-Policy": shellPolicy },
      }),
      options,
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(shellPolicy);
    expect(response.headers.has("X-Frame-Options")).toBe(false);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("falls back to the site policy when a shell response has none", () => {
    const response = withSecurityHeaders(
      new Request(`${SITE}/embed/shell/x/not-a-post`),
      new Response("Not Found", { status: 404 }),
      options,
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
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
  ])("falls back to / for %j", (value) => {
    expect(safeReturnPath(value, SITE)).toBe("/");
  });
});
