import { redirect } from "react-router";

import { profilePath } from "~/lib/slug";

import type { Route } from "./+types/profile-moved";

/** A profile's old address, /u/name, leads to its own, /@name, with any page of it. */
export function loader({ params, request }: Route.LoaderArgs) {
  return redirect(`${profilePath(params.username)}${new URL(request.url).search}`, 301);
}
