import { redirect } from "react-router";

import type { Route } from "./+types/supporter-moved";

/** `/supporter` and what follows it, from before the plan was the Fan plan: the same at `/fan`. */
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`${url.pathname.replace(/^\/supporter/, "/fan")}${url.search}`, 301);
}
