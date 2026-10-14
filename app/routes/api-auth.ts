import { authFor } from "~/lib/auth.server";

import type { Route } from "./+types/api-auth";

/** Better Auth's own endpoints: the Google callback and session reads. */
export function loader({ request }: Route.LoaderArgs) {
  return authFor(request).handler(request);
}

export function action({ request }: Route.ActionArgs) {
  return authFor(request).handler(request);
}
