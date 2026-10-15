import { handleWebhook } from "~/lib/billing/plan.server";

import type { Route } from "./+types/api-stripe";

/**
 * Stripe's webhook endpoint. It carries no cookie and no Origin, so the
 * Worker lets it past the Origin check; the signature is what proves it
 * came from Stripe.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  return handleWebhook(request);
}

export function loader() {
  return new Response(null, { status: 405 });
}
