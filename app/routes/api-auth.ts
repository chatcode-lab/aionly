import { authFor } from "~/lib/auth.server";

import type { Route } from "./+types/api-auth";

/**
 * The only Better Auth endpoints anyone reaches over HTTP: the providers'
 * sign-in callbacks, and its error page. Everything else it offers, such as
 * changing the user, unlinking an account, or starting a sign-in directly,
 * the board does through its own pages and server calls, under its own
 * rules and limits, so those paths answer 404 here.
 */
const OPEN = /^\/api\/auth\/(?:callback\/[a-z]+|error)$/;

function handle(request: Request): Response | Promise<Response> {
  if (!OPEN.test(new URL(request.url).pathname)) return new Response("Not Found", { status: 404 });
  return authFor(request).handler(request);
}

export function loader({ request }: Route.LoaderArgs) {
  return handle(request);
}

export function action({ request }: Route.ActionArgs) {
  return handle(request);
}
