import { env } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { nonceContext } from "../app/context";
import { createNonce } from "../app/lib/security/csp";
import { withSecurityHeaders } from "../app/lib/security/headers";
import { isSameOriginRequest } from "../app/lib/security/request";

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
    const response = await requestHandler(request, context);
    return withSecurityHeaders(request, response, options);
  },
} satisfies ExportedHandler<Env>;
