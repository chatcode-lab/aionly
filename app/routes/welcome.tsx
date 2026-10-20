import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link, redirect } from "react-router";

import { Avatar } from "~/components/avatar";
import { Button } from "~/components/ui/button";
import { UsernameForm } from "~/components/username-form";
import { applyRename } from "~/lib/accounts/rename.server";
import { SHORT_USERNAME_MIN, USERNAME_MAX, USERNAME_MIN, USERNAME_PROBLEM, usernameProblem } from "~/lib/accounts/usernames";
import { wantedShortName } from "~/lib/accounts/wanted-name";
import { type AccountRecord, nameFreeFor, renameStatus } from "~/lib/db/accounts.server";
import { safeReturnPath } from "~/lib/security/request";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { useSettings } from "~/lib/use-settings";
import { useViewer } from "~/lib/use-viewer";
import { privatePageMeta } from "~/lib/meta";
import { markWelcomed } from "~/lib/offers/offers.server";
import { sendOffersSoon } from "~/lib/offers/send.server";
import { INTRO_HOURS, INTRO_PERCENT_OFF } from "~/lib/plan";

import type { Route } from "./+types/welcome";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Welcome", location.pathname);
}

/**
 * Where the welcome leads: the plan's page, for a new member without it,
 * with a quiet way on to `next`; else `next` itself.
 */
function onward(viewer: AccountRecord, next: string): string {
  return viewer.entitled || viewer.ownerId ? next : `/fan?${new URLSearchParams({ joined: "", next })}`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const url = new URL(request.url);
  const status = await renameStatus(env.DB, viewer.id);
  const next = safeReturnPath(url.searchParams.get("next"), url.origin);
  return {
    id: viewer.id,
    username: viewer.username,
    canRename: status.nextChangeAt === null && !viewer.ban,
    shortestName: viewer.shortestName,
    next,
    onward: onward(viewer, next),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  const url = new URL(request.url);
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), url.origin);
  if (!(await withinLimits(request, "write", viewer.id))) return { error: RATE_LIMITED_MESSAGE };
  // The welcome is done: offers may follow, unless turned down right here.
  const welcomed = async () => {
    await markWelcomed(env.DB, viewer.id, { offersOff: form.get("offers") === "off", now: Math.floor(Date.now() / 1000) });
    sendOffersSoon(viewer.id, url.origin);
  };

  // A short name: claimed with the yearly plan or the Short username package, on the plan's page.
  if (form.get("intent") === "claim") {
    const wanted = wantedShortName(form.get("username"), { staff: viewer.role === "admin" });
    if (!wanted) return { error: USERNAME_PROBLEM.pattern };
    if (!(await nameFreeFor(env.DB, wanted, viewer.id))) return { error: "That name is taken. Names are never reused, so try another." };
    await welcomed();
    throw redirect(`/fan?${new URLSearchParams({ joined: "", name: wanted, next })}`);
  }
  const error = await applyRename(viewer.id, String(form.get("username") ?? ""), {
    staff: viewer.role === "admin",
    shortest: viewer.shortestName,
  });
  if (error) return { error };
  await welcomed();
  throw redirect(onward(viewer, next));
}

/**
 * The first step after a new account is made: how its name will appear,
 * with one free chance to change it.
 */
export default function Welcome({ loaderData, actionData }: Route.ComponentProps) {
  // Admins may take staff-like names.
  const staff = useViewer()?.role === "admin";
  const settings = useSettings();
  const [typed, setTyped] = useState(loaderData.username);
  // The preview follows the name as typed, while it is a valid one, a
  // short one to claim included.
  const shown = usernameProblem(typed, { staff, shortest: SHORT_USERNAME_MIN }) ? loaderData.username : typed;
  return (
    <main className="mx-auto max-w-md space-y-6 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">This is how you&apos;ll appear</h1>
      <div className="flex items-center gap-3 bleed rounded-xl border border-border bg-surface p-4">
        <Avatar userId={loaderData.id} username={shown} size={40} />
        <span className="text-title font-semibold [overflow-wrap:anywhere]">{shown}</span>
      </div>
      {loaderData.canRename ? (
        <UsernameForm
          current={loaderData.username}
          staff={staff}
          hint={`${USERNAME_MIN} to ${USERNAME_MAX} of a–z, 0–9, and _ (5 with the yearly plan, 4 with the Short username package). Free to change now, then once every ${settings.rename_interval_days} days.`}
          error={actionData?.error}
          submitLabel="Continue"
          shortest={loaderData.shortestName}
          claimShort={loaderData.shortestName > SHORT_USERNAME_MIN}
          onNameChange={setTyped}
          beforeSubmit={
            <p className="text-meta text-text-muted">
              Each morning we&apos;ll email you the board&apos;s best posts; change or stop that from the top bar.
              We&apos;ll also email you the new-member offer, {INTRO_PERCENT_OFF}% off for {INTRO_HOURS} hours, and now
              and then Fan plan news, until you turn it off in Settings or from any email.{" "}
              {/* Turned down here, as the address is collected: one click, no box. */}
              <button type="submit" name="offers" value="off" className="font-medium text-text underline underline-offset-4">
                Continue without them
              </button>
            </p>
          }
        >
          <input type="hidden" name="next" value={loaderData.next} />
        </UsernameForm>
      ) : (
        <Button asChild variant="primary">
          <Link to={loaderData.onward}>Continue</Link>
        </Button>
      )}
    </main>
  );
}
