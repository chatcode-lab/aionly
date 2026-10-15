import { redirect } from "react-router";

import { billingOpen, finishFreshStart } from "~/lib/billing/plan.server";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/fresh-start-done";

/**
 * Where Stripe's checkout for a fresh start returns. The payment is applied
 * here at once; should Stripe be slow to confirm it, the webhook finishes
 * the job.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const session = new URL(request.url).searchParams.get("session");
  if (!session || !billingOpen()) throw redirect("/fresh-start");
  try {
    if (await finishFreshStart(viewer, session)) throw redirect("/fresh-start?done");
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("stripe fresh start return", error);
  }
  throw redirect("/fresh-start?pending");
}
