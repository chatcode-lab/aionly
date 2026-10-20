import { env } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { nonceContext, viewerContext, waitUntilContext } from "../app/context";
import { sweepExpiredVerifications } from "../app/lib/db/accounts.server";
import { sweepInviteClaims } from "../app/lib/db/invites.server";
import { sweepPartnerJoins } from "../app/lib/db/partners.server";
import { sweepDeletedIdentities } from "../app/lib/db/deletion.server";
import { sweepPublishedDrafts } from "../app/lib/db/drafts.server";
import { sendDigests } from "../app/lib/digest/digest.server";
import { bulkMailer, transactionalMailer } from "../app/lib/mail/mailers.server";
import { SENDERS } from "../app/lib/mail/senders";
import { sendPlanEndNotices, sendReadOnlyNotices, sweepSignInLinkSends } from "../app/lib/notices/notices.server";
import { sendOfferEmails } from "../app/lib/offers/offers.server";
import { sweepDeletedUploads } from "../app/lib/uploads.server";
import { sweepDeletedPostImages, sweepPendingImages } from "../app/lib/images.server";
import { createNonce } from "../app/lib/security/csp";
import { withSecurityHeaders } from "../app/lib/security/headers";
import { isSameOriginRequest } from "../app/lib/security/request";
import { authorizationServerMetadata, protectedResourceMetadata } from "../app/lib/oauth/metadata";
import { sweepOAuth } from "../app/lib/oauth/clients.server";
import { loadViewer } from "../app/lib/viewer.server";
import { htmlToMarkdown, mainOf } from "../app/lib/views/html-markdown";
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

/** Pages of plain prose whose Markdown is their rendered page, converted. */
const MARKDOWN_PAGES = new Set(["/rules", "/terms", "/privacy"]);

/**
 * A prose page as Markdown: rendered as a signed-out visitor sees it, and
 * its main content converted. Only the board's own simple pages come here.
 */
async function pageAsMarkdown(origin: string, path: string, ctx: ExecutionContext): Promise<Response | null> {
  const context = new RouterContextProvider();
  context.set(nonceContext, createNonce());
  context.set(viewerContext, () => Promise.resolve(null));
  context.set(waitUntilContext, (work) => ctx.waitUntil(work));
  const page = await requestHandler(new Request(`${origin}${path}`, { headers: { Accept: "text/html" } }), context);
  if (page.status !== 200) return null;
  return new Response(htmlToMarkdown(mainOf(await page.text()), origin), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": "public, max-age=60",
      Link: `<${origin}${path}>; rel="canonical"`,
    },
  });
}

/** A request the browser makes ahead of need, as for `<link rel="prefetch">`. */
function isPrefetch(request: Request): boolean {
  return ["Sec-Purpose", "Purpose", "X-Moz"].some((name) => request.headers.get(name)?.includes("prefetch") === true);
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
    pathname === "/unsubscribe" ||
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
    // Covers for shared links, drawn on first request and then cached. The
    // renderer loads only here, so no other request pays for it. A post's
    // or profile's is looked up live before the cache, so a removed post's
    // cover is gone at once; each is kept by its path and version.
    if (url.pathname.startsWith("/og/")) {
      const { coverResponse } = await import("../app/lib/og/covers.server");
      const response = await coverResponse(url, env.DB, env.IMAGES, (key, make) => cached(ctx, key, make));
      return withSecurityHeaders(request, response ?? new Response("Not Found", { status: 404 }), options);
    }
    // Every public page is Markdown at its address plus .md (the home page
    // at /index.md), whatever the request asks for, for agents whose tools
    // cannot choose a format; and at its own address to a request that asks.
    const markdownPath = url.pathname.endsWith(".md") ? (url.pathname === "/index.md" ? "/" : url.pathname.slice(0, -3)) : null;
    if (wantsMarkdown(request) || markdownPath !== null) {
      const path = markdownPath ?? url.pathname;
      // Always made in full, so a HEAD request never caches an empty page;
      // its answer drops the body below.
      const target = new Request(new URL(`${path}${url.search}`, url.origin), { headers: { Accept: "text/markdown" } });
      const response = await cached(ctx, `${url.origin}/__markdown${path}${url.search}`, async () =>
        (await markdownView(target, env.DB)) ?? (MARKDOWN_PAGES.has(path) ? pageAsMarkdown(url.origin, path, ctx) : null),
      );
      if (response && markdownPath !== null && response.status === 301) {
        // An old name's profile, sent on to the current one's Markdown.
        const moved = new Response(null, response);
        moved.headers.set("Location", `${response.headers.get("Location")}.md`);
        return withSecurityHeaders(request, moved, options);
      }
      if (response) {
        return withSecurityHeaders(request, request.method === "HEAD" ? new Response(null, response) : response, options);
      }
      if (markdownPath !== null) {
        const missing = new Response("Nothing is at this address in Markdown.\n", {
          status: 404,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
        return withSecurityHeaders(request, missing, options);
      }
    }
  }

  // A page's data, fetched ahead as a link is pointed at. Pages are never
  // kept without checking back (`private, no-cache`), so the click fetches
  // it again: the read ahead would be wasted, and is declined before any
  // loader runs (review F86). The page's code still loads ahead.
  if (request.method === "GET" && url.pathname.endsWith(".data") && isPrefetch(request)) {
    return withSecurityHeaders(request, new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }), options);
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
  // identities once they may sign up again, OAuth codes and apps no longer
  // needed, and drafts published a month ago; and sends the digests that
  // are due.
  async scheduled(_controller, workerEnv, ctx) {
    ctx.waitUntil(
      sweepPendingImages(workerEnv.DB, workerEnv.IMAGES, Math.floor(Date.now() / 1000)),
    );
    ctx.waitUntil(sweepDeletedPostImages(workerEnv.DB, workerEnv.IMAGES));
    ctx.waitUntil(sweepExpiredVerifications(workerEnv.DB, new Date()));
    ctx.waitUntil(sweepSignInLinkSends(workerEnv.DB, Math.floor(Date.now() / 1000)));
    ctx.waitUntil(sweepDeletedIdentities(workerEnv.DB, Math.floor(Date.now() / 1000)));
    ctx.waitUntil(sweepDeletedUploads(workerEnv.DB, workerEnv.IMAGES));
    ctx.waitUntil(sweepOAuth(workerEnv.DB, Math.floor(Date.now() / 1000)));
    ctx.waitUntil(sweepPublishedDrafts(workerEnv.DB, Math.floor(Date.now() / 1000)));
    // Invitation and partner claims whose sign-up never finished.
    ctx.waitUntil(sweepInviteClaims(workerEnv.DB, Math.floor(Date.now() / 1000)));
    ctx.waitUntil(sweepPartnerJoins(workerEnv.DB, Math.floor(Date.now() / 1000)));
    // Digests that are due: each period's, for whoever has not had it yet.
    // Digests and offers go through Amazon SES only, where it is set up.
    const origin = workerEnv.SITE_ORIGIN;
    if (origin) {
      const bulk = bulkMailer();
      if (bulk) {
        ctx.waitUntil(
          sendDigests(workerEnv.DB, bulk, {
            origin,
            secret: workerEnv.BETTER_AUTH_SECRET,
            from: workerEnv.DIGEST_FROM ?? SENDERS.digest.from.email,
            now: Math.floor(Date.now() / 1000),
          }),
        );
        // Reminders before a new member's price ends, and any welcome offer
        // that failed, to members with offers on.
        ctx.waitUntil(
          sendOfferEmails(workerEnv.DB, bulk, {
            origin,
            secret: workerEnv.BETTER_AUTH_SECRET,
            now: Math.floor(Date.now() / 1000),
          }),
        );
      }
      // Members whose karma reached the floor: that they are read-only, and
      // the ways back. Through SES, or Cloudflare where SES cannot.
      ctx.waitUntil(sendReadOnlyNotices(workerEnv.DB, transactionalMailer(workerEnv.EMAIL), { origin, now: Math.floor(Date.now() / 1000) }));
      // Members whose plan is ending: what stops, and that a short name is no longer certain.
      ctx.waitUntil(sendPlanEndNotices(workerEnv.DB, transactionalMailer(workerEnv.EMAIL), { origin, now: Math.floor(Date.now() / 1000) }));
    }
  },
} satisfies ExportedHandler<Env>;
