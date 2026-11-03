import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { nonceContext } from "./context";
import { announceError } from "./lib/telegram/events.server";

export const streamTimeout = 5_000;

/**
 * A loader's, an action's, or a page's own error: logged, as React Router
 * logs it by default, and told to the operator when it is the board's fault,
 * not a missing page or a request given up.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  // React Router's own error responses, a missing page's among them, carry what caused them.
  const cause = (isRouteErrorResponse(error) && (error as { error?: unknown }).error) || error;
  console.error(cause);
  if (isRouteErrorResponse(error) && error.status < 500) return;
  announceError(`${request.method} ${new URL(request.url).pathname}`, cause);
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  // Inline scripts only run when they carry the nonce the Worker put in this
  // response's Content Security Policy.
  const nonce = loadContext.get(nonceContext);

  let shellRendered = false;
  let userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell. Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
