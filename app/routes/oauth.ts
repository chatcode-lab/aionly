import { env } from "cloudflare:workers";

import { revokePresentedToken } from "~/lib/db/agents.server";
import { AGENT_SCOPE } from "~/lib/oauth/metadata";
import { exchangeCode, registerClient } from "~/lib/oauth/clients.server";
import { withinLimits } from "~/lib/security/rate-limit.server";

import type { Route } from "./+types/oauth";

/**
 * The OAuth endpoints apps call themselves, never a browser with the
 * member's cookies: the token exchange, registration (RFC 7591), and
 * revocation (RFC 7009). Each answers JSON that is never cached.
 */

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

const MAX_BODY = 8 * 1024;

const oauthError = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: NO_STORE });

async function smallText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY) return null;
  const text = await request.text();
  return text.length > MAX_BODY ? null : text;
}

async function token(request: Request): Promise<Response> {
  if (!(await withinLimits(request, "signin", null))) return oauthError("slow_down", "Too many requests. Try again in a minute.", 429);
  const text = await smallText(request);
  if (text === null) return oauthError("invalid_request", "The request is too large.");
  const result = await exchangeCode(env.DB, new URLSearchParams(text), {
    now: Math.floor(Date.now() / 1000),
    origin: new URL(request.url).origin,
  });
  if (!result.ok) return oauthError(result.error, result.description);
  // An agent token: it lasts until the owner revokes it in Settings.
  return Response.json({ access_token: result.token, token_type: "Bearer", scope: AGENT_SCOPE }, { headers: NO_STORE });
}

async function register(request: Request): Promise<Response> {
  if (!(await withinLimits(request, "signin", null))) return oauthError("slow_down", "Too many requests. Try again in a minute.", 429);
  const text = await smallText(request);
  if (text === null) return oauthError("invalid_client_metadata", "The request is too large.");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return oauthError("invalid_client_metadata", "Send JSON.");
  }
  const result = await registerClient(env.DB, input, Math.floor(Date.now() / 1000));
  if (!result.ok) return oauthError(result.error, result.description);
  return Response.json(result.client, { status: 201, headers: NO_STORE });
}

async function revoke(request: Request): Promise<Response> {
  const text = await smallText(request);
  const presented = text === null ? null : new URLSearchParams(text).get("token");
  if (presented) await revokePresentedToken(env.DB, presented, Math.floor(Date.now() / 1000));
  // RFC 7009: the answer is the same whether or not the token was known.
  return new Response(null, { status: 200, headers: NO_STORE });
}

export function loader() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  switch (params.endpoint) {
    case "token":
      return token(request);
    case "register":
      return register(request);
    case "revoke":
      return revoke(request);
    default:
      return new Response("Not found", { status: 404 });
  }
}
