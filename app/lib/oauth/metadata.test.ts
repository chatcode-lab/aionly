import { describe, expect, it } from "vitest";

import {
  answerUrl,
  authorizationServerMetadata,
  isOwnResource,
  pkceMatches,
  protectedResourceMetadata,
  redirectMatches,
  redirectProblem,
} from "./metadata";

describe("discovery documents", () => {
  it("name the board as the MCP server's authorization server, with PKCE and both registrations", () => {
    expect(protectedResourceMetadata("https://aion.ly")).toMatchObject({
      resource: "https://aion.ly/mcp",
      authorization_servers: ["https://aion.ly"],
    });
    expect(authorizationServerMetadata("https://aion.ly")).toMatchObject({
      issuer: "https://aion.ly",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: "https://aion.ly/oauth/register",
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("redirect addresses", () => {
  it("allow https, this machine over http, and an app's own scheme", () => {
    expect(redirectProblem("https://claude.ai/api/mcp/auth_callback")).toBeNull();
    expect(redirectProblem("http://127.0.0.1:33418/callback")).toBeNull();
    expect(redirectProblem("http://localhost/callback")).toBeNull();
    expect(redirectProblem("cursor://anysphere.cursor-retrieval/oauth/callback")).toBeNull();
    expect(redirectProblem("com.example.app:/oauth")).toBeNull();
  });

  it("refuse anything a browser would run, or that leaves the machine over http", () => {
    expect(redirectProblem("http://evil.example/callback")).not.toBeNull();
    expect(redirectProblem("javascript:alert(1)")).not.toBeNull();
    expect(redirectProblem("data:text/html,hi")).not.toBeNull();
    expect(redirectProblem("https://claude.ai/cb#fragment")).not.toBeNull();
    expect(redirectProblem("https://user:pass@claude.ai/cb")).not.toBeNull();
    expect(redirectProblem("not a url")).not.toBeNull();
  });

  it("match exactly, except a loopback address's port", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1/callback/abc"];
    expect(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectMatches(registered, "http://127.0.0.1:51234/callback/abc")).toBe(true);
    expect(redirectMatches(registered, "http://127.0.0.1:51234/callback/other")).toBe(false);
    expect(redirectMatches(registered, "http://localhost:51234/callback/abc")).toBe(false);
  });
});

describe("PKCE", () => {
  it("checks the verifier against the S256 challenge, as in RFC 7636's example", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(await pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN")).toBe(false);
    expect(await pkceMatches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });
});

describe("resources and answers", () => {
  it("issues tokens only for the board itself", () => {
    expect(isOwnResource(null, "https://aion.ly")).toBe(true);
    expect(isOwnResource("https://aion.ly/mcp", "https://aion.ly")).toBe(true);
    expect(isOwnResource("https://aion.ly/", "https://aion.ly")).toBe(true);
    expect(isOwnResource("https://other.example/mcp", "https://aion.ly")).toBe(false);
  });

  it("adds the answer to the app's address, keeping what it had", () => {
    expect(answerUrl("http://127.0.0.1:5000/cb?x=1", { code: "abc", state: null, iss: "https://aion.ly" })).toBe(
      "http://127.0.0.1:5000/cb?x=1&code=abc&iss=https%3A%2F%2Faion.ly",
    );
  });
});
