import { handleApi } from "~/lib/api/v1.server";

import type { Route } from "./+types/api-v1";

export function loader({ request, params }: Route.LoaderArgs) {
  return handleApi(request, params["*"]);
}

export function action({ request, params }: Route.ActionArgs) {
  return handleApi(request, params["*"]);
}
