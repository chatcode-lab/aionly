import { redirect } from "react-router";

import { authFor } from "~/lib/auth.server";

import type { Route } from "./+types/signout";

/** Ends the session in D1 and clears its cookie, then goes home. */
export async function action({ request }: Route.ActionArgs) {
  const response = await authFor(request).api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  const headers = new Headers();
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  return redirect("/", { headers });
}

export function loader() {
  return redirect("/");
}
