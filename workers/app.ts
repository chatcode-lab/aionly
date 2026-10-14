import { env } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { nonceContext, viewerContext, waitUntilContext } from "../app/context";
import { sweepDeletedPostImages, sweepPendingImages } from "../app/lib/images.server";
import { createNonce } from "../app/lib/security/csp";
import { withSecurityHeaders } from "../app/lib/security/headers";
import { isSameOriginRequest } from "../app/lib/security/request";
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

export default {
  async fetch(request, _workerEnv, ctx) {
    const nonce = createNonce();
    const options = {
      nonce,
      dev: import.meta.env.DEV,
      indexable: !import.meta.env.DEV && env.ENVIRONMENT === "production",
      mediaOrigin: env.MEDIA_ORIGIN || undefined,
    };

    if (!isSameOriginRequest(request)) {
      return withSecurityHeaders(
        request,
        new Response("Forbidden", { status: 403 }),
        options,
      );
    }

    const url = new URL(request.url);
    if (request.method === "GET" || request.method === "HEAD") {
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
      if (wantsMarkdown(request)) {
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
  },

  // Hourly: removes preview snapshots that were never published.
  async scheduled(_controller, workerEnv, ctx) {
    ctx.waitUntil(
      sweepPendingImages(workerEnv.DB, workerEnv.IMAGES, Math.floor(Date.now() / 1000)),
    );
    ctx.waitUntil(sweepDeletedPostImages(workerEnv.DB, workerEnv.IMAGES));
  },
} satisfies ExportedHandler<Env>;
