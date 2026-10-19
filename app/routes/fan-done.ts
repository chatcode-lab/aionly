import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import { applyRename } from "~/lib/accounts/rename.server";
import { SHORT_USERNAME_MIN } from "~/lib/accounts/usernames";
import { wantedShortName } from "~/lib/accounts/wanted-name";
import { billingOpen, finishCheckout } from "~/lib/billing/plan.server";
import { claimCheckoutReturn, releaseCheckoutReturn } from "~/lib/db/subscriptions.server";
import { safeReturnPath } from "~/lib/security/request";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/fan-done";

/**
 * Where Stripe's checkout returns. The subscription it made, or the short
 * username it bought, is applied here at once, so it is on when the page
 * loads, without waiting for the webhook. Should Stripe be slow to
 * confirm, the webhook finishes the job. A short name the checkout carried
 * is taken as soon as what allows it is on, and the thanks offer the way
 * back to where the member was going.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const url = new URL(request.url);
  const session = url.searchParams.get("session");
  if (!session || !billingOpen()) throw redirect("/fan");
  try {
    const done = await finishCheckout(viewer, session);
    if (done.applied) {
      // Thanks for the plan, or for the name alone.
      const query = new URLSearchParams(done.plan ? { welcome: "" } : { bought: "" });
      if (done.then) query.set("next", safeReturnPath(done.then, url.origin));
      const wanted = wantedShortName(done.wantedName, { staff: viewer.role === "admin" });
      // Once a checkout: a later visit to this address, from history or a
      // saved link, never renames the member again.
      if (wanted && (await claimCheckoutReturn(env.DB, session, viewer.id, Math.floor(Date.now() / 1000)))) {
        let refused: string | null;
        try {
          // Checked again inside the write: what allows it, now on, and the name still free.
          refused = await applyRename(viewer.id, wanted, { staff: viewer.role === "admin", shortest: SHORT_USERNAME_MIN });
        } catch (error) {
          await releaseCheckoutReturn(env.DB, session);
          throw error;
        }
        if (refused) query.set("name_error", `${wanted} could not be yours: ${refused}`);
        else query.set("named", wanted);
      }
      throw redirect(`/fan?${query}`);
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("stripe checkout return", error);
  }
  throw redirect("/fan?pending");
}
