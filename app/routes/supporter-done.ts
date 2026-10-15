import { redirect } from "react-router";

import { billingOpen, finishCheckout } from "~/lib/billing/plan.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/supporter-done";

/**
 * Where Stripe's checkout returns. The subscription it made is applied here
 * at once, so the plan is on when the page loads, without waiting for the
 * webhook. Should Stripe be slow to confirm, the webhook finishes the job.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const session = new URL(request.url).searchParams.get("session");
  if (!session || !billingOpen()) throw redirect("/supporter");
  try {
    if (await finishCheckout(viewer, session)) {
      // Read again, so the plan just applied counts.
      throw redirect("/supporter?welcome");
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("stripe checkout return", error);
  }
  throw redirect("/supporter?pending");
}
