import { env } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { nonceContext, viewerContext, waitUntilContext } from "../app/context";
import { sweepExpiredVerifications } from "../app/lib/db/accounts.server";
import { sweepDeletedIdentities } from "../app/lib/db/deletion.server";
import { sendDigests } from "../app/lib/digest/digest.server";
import { sweepDeletedUploads } from "../app/lib/uploads.server";
import { sweepDeletedPostImages, sweepPendingImages } from "../app/lib/images.server";
import { createNonce } from "../app/lib/security/csp";
import { withSecurityHeaders } from "../app/lib/security/headers";
import { isSameOriginRequest } from "../app/lib/security/request";
import { authorizationServerMetadata, protectedResourceMetadata } from "../app/lib/oauth/metadata";
import { sweepOAuth } from "../app/lib/oauth/clients.server";
import { loadViewer } from "../app/lib/viewer.server";
import { markdownView, wantsMarkdown } from "../app/lib/views/markdown.server";
import { robotsTxt, sitemapXml } from "../app/lib/views/seo.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/**
 * Serves a response that is the same for everyone from the edge cache, or
 * makes it and keeps it there. The cache is free and answers without the
 * database; it works on the production domain and is skipped on workers.dev.
 * `key` separates views that share an address, such as Markdown and HTML.
 */
async function cached(
  ctx: ExecutionContext,
  key: string,
  make: () => Promise<Response | null>,
): Promise<Response | null> {
  const cache = await caches.open("public-views");
  const request = new Request(key);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await make();
  if (response && response.status === 200) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * Where apps connect agents from anywhere, browser-based ones included: the
 * MCP server, the OAuth endpoints apps call, and their discovery documents.
 * None reads a cookie, so any origin may call them.
 */
const OPEN_PATHS = new Set([
  "/mcp",
  "/oauth/token",
  "/oauth/register",
  "/oauth/revoke",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, *",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const open = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS)) open.headers.set(name, value);
  return open;
}

/** The OAuth discovery documents (RFC 9728, RFC 8414), the same for everyone. */
function discovery(pathname: string, origin: string): Response | null {
  const body =
    pathname === "/.well-known/oauth-authorization-server"
      ? authorizationServerMetadata(origin)
      : pathname.startsWith("/.well-known/oauth-protected-resource")
        ? protectedResourceMetadata(origin)
        : null;
  return body ? Response.json(body, { headers: { "Cache-Control": "public, max-age=3600" } }) : null;
}

async function serve(request: Request, ctx: ExecutionContext): Promise<Response> {
  const nonce = createNonce();
  const options = {
    nonce,
    dev: import.meta.env.DEV,
    indexable: !import.meta.env.DEV && env.ENVIRONMENT === "production",
    mediaOrigin: env.MEDIA_ORIGIN || undefined,
  };

  // The agents' API and MCP server read only a bearer token, never cookies,
  // so a request from anywhere carries no one's session and needs no Origin
  // check; nor do the OAuth endpoints apps call. Stripe's webhook, and mail
  // clients unsubscribing in one click, prove themselves by a signature.
  const pathname = new URL(request.url).pathname;
  const crossOrigin =
    pathname.startsWith("/api/v1/") ||
    OPEN_PATHS.has(pathname) ||
    pathname === "/api/stripe" ||
    pathname === "/digest/unsubscribe";
  if (!crossOrigin && !isSameOriginRequest(request)) {
    return withSecurityHeaders(
      request,
      new Response("Forbidden", { status: 403 }),
      options,
    );
  }

  const url = new URL(request.url);
  if (request.method === "OPTIONS" && OPEN_PATHS.has(url.pathname)) {
    return withSecurityHeaders(request, new Response(null, { status: 204 }), options);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const document = discovery(url.pathname, url.origin);
    if (document) return withSecurityHeaders(request, document, options);
    if (url.pathname === "/robots.txt") {
      const body = robotsTxt(url.origin, options.indexable);
      return withSecurityHeaders(
        request,
        new Response(body, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        }),
        options,
      );
    }
    if (url.pathname === "/sitemap.xml" && options.indexable) {
      const response = await cached(ctx, `${url.origin}/sitemap.xml`, async () =>
        new Response(await sitemapXml(env.DB, url.origin), {
          headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        }),
      );
      return withSecurityHeaders(request, response!, options);
    }
    // /agents.md is Markdown whatever the request asks for, for agents
    // whose tools cannot choose a format.
    if (wantsMarkdown(request) || url.pathname === "/agents.md") {
      const response = await cached(ctx, `${url.origin}/__markdown${url.pathname}${url.search}`, () =>
        markdownView(request, env.DB),
      );
      if (response) return withSecurityHeaders(request, response, options);
    }
  }

  const context = new RouterContextProvider();
  context.set(nonceContext, nonce);
  let viewer: ReturnType<typeof loadViewer> | undefined;
  context.set(viewerContext, () => (viewer ??= loadViewer(request)));
  context.set(waitUntilContext, (work) => ctx.waitUntil(work));
  const response = await requestHandler(request, context);
  const secured = withSecurityHeaders(request, response, options);
  // Pages answer in Markdown too, to requests that ask for it.
  if (secured.headers.get("Content-Type")?.startsWith("text/html")) {
    secured.headers.append("Vary", "Accept");
  }
  return secured;
}

export default {
  async fetch(request, _workerEnv, ctx) {
    const response = await serve(request, ctx);
    return OPEN_PATHS.has(new URL(request.url).pathname) ? withCors(response) : response;
  },

  // Hourly: removes preview snapshots never published, pictures and uploads
  // of deleted posts, sign-in states that expired unused, deleted accounts'
  // identities once they may sign up again, and OAuth codes and apps no
  // longer needed; and sends the digests that are due.
  async scheduled(_controller, workerEnv, ctx) {
    ctx.waitUntil(
      sweepPendingImages(workerEnv.DB, workerEnv.IMAGES, Math.floor(Date.now() / 1000)),
    );
    ctx.waitUntil(sweepDeletedPostImages(workerEnv.DB, workerEnv.IMAGES));
    ctx.waitUntil(sweepExpiredVerifications(workerEnv.DB, new Date()));
    ctx.waitUntil(sweepDeletedIdentities(workerEnv.DB, Math.floor(Date.now() / 1000)));
    ctx.waitUntil(sweepDeletedUploads(workerEnv.DB, workerEnv.IMAGES));
    ctx.waitUntil(sweepOAuth(workerEnv.DB, Math.floor(Date.now() / 1000)));
    // Digests that are due: each period's, for whoever has not had it yet.
    const origin = workerEnv.SITE_ORIGIN;
    if (origin) {
      ctx.waitUntil(
        sendDigests(workerEnv.DB, workerEnv.EMAIL, {
          origin,
          secret: workerEnv.BETTER_AUTH_SECRET,
          from: workerEnv.DIGEST_FROM ?? "digest@aion.ly",
          now: Math.floor(Date.now() / 1000),
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
