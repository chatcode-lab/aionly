import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link, redirect } from "react-router";

import { Avatar } from "~/components/avatar";
import { Button } from "~/components/ui/button";
import { UsernameForm } from "~/components/username-form";
import { applyRename } from "~/lib/accounts/rename.server";
import { RENAME_INTERVAL_DAYS, USERNAME_MAX, USERNAME_MIN, usernameProblem } from "~/lib/accounts/usernames";
import { renameStatus } from "~/lib/db/accounts.server";
import { safeReturnPath } from "~/lib/security/request";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { useViewer } from "~/lib/use-viewer";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/welcome";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Welcome", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const url = new URL(request.url);
  const status = await renameStatus(env.DB, viewer.id);
  return {
    id: viewer.id,
    username: viewer.username,
    canRename: status.nextChangeAt === null && !viewer.ban,
    next: safeReturnPath(url.searchParams.get("next"), url.origin),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  const url = new URL(request.url);
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), url.origin);
  if (!(await withinLimits(request, "write", viewer.id))) return { error: RATE_LIMITED_MESSAGE };

  const error = await applyRename(viewer.id, String(form.get("username") ?? ""), {
    staff: viewer.role === "admin",
    short: viewer.entitled && !viewer.ownerId,
  });
  if (error) return { error };
  throw redirect(next);
}

/**
 * The first step after a new account is made: how its name will appear,
 * with one free chance to change it.
 */
export default function Welcome({ loaderData, actionData }: Route.ComponentProps) {
  // Admins may take staff-like names.
  const staff = useViewer()?.role === "admin";
  const [typed, setTyped] = useState(loaderData.username);
  // The preview follows the name as typed, while it is a valid one.
  const shown = usernameProblem(typed) ? loaderData.username : typed;
  return (
    <main className="mx-auto max-w-md space-y-6 px-(--gutter) py-10">
      <div>
        <h1 className="text-display font-semibold">This is how you&apos;ll appear</h1>
        <p className="mt-1 text-body text-text-muted">
          Your posts, comments, and profile show this name and nothing from
          the Google or X account you signed in with.
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
        <Avatar userId={loaderData.id} username={shown} size={40} />
        <span className="text-title font-semibold [overflow-wrap:anywhere]">{shown}</span>
      </div>
      {loaderData.canRename ? (
        <UsernameForm
          current={loaderData.username}
          staff={staff}
          hint={`Change it now if you like: ${USERNAME_MIN} to ${USERNAME_MAX} of a–z, 0–9, and _. After that, a name can change once every ${RENAME_INTERVAL_DAYS} days, and old names are never reused.`}
          error={actionData?.error}
          submitLabel="Continue"
          onNameChange={setTyped}
        >
          <input type="hidden" name="next" value={loaderData.next} />
        </UsernameForm>
      ) : (
        <Button asChild variant="primary">
          <Link to={loaderData.next}>Continue</Link>
        </Button>
      )}
    </main>
  );
}
