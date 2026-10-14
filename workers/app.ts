import { env } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { nonceContext, viewerContext } from "../app/context";
import { sweepPendingImages } from "../app/lib/images.server";
import { createNonce } from "../app/lib/security/csp";
import { withSecurityHeaders } from "../app/lib/security/headers";
import { isSameOriginRequest } from "../app/lib/security/request";
import { loadViewer } from "../app/lib/viewer.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    const nonce = createNonce();
    const options = {
      nonce,
      dev: import.meta.env.DEV,
      indexable: !import.meta.env.DEV && env.ENVIRONMENT === "production",
    };

    if (!isSameOriginRequest(request)) {
      return withSecurityHeaders(
        request,
        new Response("Forbidden", { status: 403 }),
        options,
      );
    }

    const context = new RouterContextProvider();
    context.set(nonceContext, nonce);
    let viewer: ReturnType<typeof loadViewer> | undefined;
    context.set(viewerContext, () => (viewer ??= loadViewer(request)));
    const response = await requestHandler(request, context);
    return withSecurityHeaders(request, response, options);
  },

  // Hourly: removes preview snapshots that were never published.
  async scheduled(_controller, workerEnv, ctx) {
    ctx.waitUntil(
      sweepPendingImages(workerEnv.DB, workerEnv.IMAGES, Math.floor(Date.now() / 1000)),
    );
  },
} satisfies ExportedHandler<Env>;
