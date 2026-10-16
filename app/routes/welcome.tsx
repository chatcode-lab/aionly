import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link, redirect } from "react-router";

import { Avatar } from "~/components/avatar";
import { Button } from "~/components/ui/button";
import { UsernameForm } from "~/components/username-form";
import { applyRename } from "~/lib/accounts/rename.server";
import { USERNAME_MAX, USERNAME_MIN, USERNAME_PROBLEM, usernameProblem } from "~/lib/accounts/usernames";
import { wantedShortName } from "~/lib/accounts/wanted-name";
import { type AccountRecord, nameFreeFor, renameStatus } from "~/lib/db/accounts.server";
import { safeReturnPath } from "~/lib/security/request";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { useSettings } from "~/lib/use-settings";
import { useViewer } from "~/lib/use-viewer";
import { privatePageMeta } from "~/lib/meta";
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
    shortNames: viewer.shortNames,
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
  // The new member's offer by email, unless they turned offers off.
  const welcomed = () => sendOffersSoon(viewer.id, url.origin);

  // A name of 4 or 5 characters: claimed with the yearly plan, on its page.
  if (form.get("intent") === "claim") {
    const wanted = wantedShortName(form.get("username"), { staff: viewer.role === "admin" });
    if (!wanted) return { error: USERNAME_PROBLEM.pattern };
    if (!(await nameFreeFor(env.DB, wanted, viewer.id))) return { error: "That name is taken. Names are never reused, so try another." };
    welcomed();
    throw redirect(`/fan?${new URLSearchParams({ joined: "", name: wanted, next })}`);
  }
  const error = await applyRename(viewer.id, String(form.get("username") ?? ""), {
    staff: viewer.role === "admin",
    short: viewer.shortNames,
  });
  if (error) return { error };
  welcomed();
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
  const shown = usernameProblem(typed, { staff, short: true }) ? loaderData.username : typed;
  return (
    <main className="mx-auto max-w-md space-y-6 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">This is how you&apos;ll appear</h1>
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
        <Avatar userId={loaderData.id} username={shown} size={40} />
        <span className="text-title font-semibold [overflow-wrap:anywhere]">{shown}</span>
      </div>
      {loaderData.canRename ? (
        <UsernameForm
          current={loaderData.username}
          staff={staff}
          hint={`${USERNAME_MIN} to ${USERNAME_MAX} of a–z, 0–9, and _ (4 or 5 with the yearly plan). Free to change now, then once every ${settings.rename_interval_days} days.`}
          error={actionData?.error}
          submitLabel="Continue"
          short={loaderData.shortNames}
          claimShort={!loaderData.shortNames}
          onNameChange={setTyped}
          beforeSubmit={
            <p className="text-meta text-text-muted">
              We&apos;ll email you the new-member offer, {INTRO_PERCENT_OFF}% off for {INTRO_HOURS} hours, and now
              and then Fan plan news. Turn it off in{" "}
              <Link to="/settings#email" className="underline underline-offset-4">
                Settings
              </Link>{" "}
              or from any email.
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
