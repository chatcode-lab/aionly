import { env } from "cloudflare:workers";
import { useId } from "react";
import { Form, useNavigation } from "react-router";

import { Avatar } from "~/components/avatar";
import { UsernameForm } from "~/components/username-form";
import { Button } from "~/components/ui/button";
import { Notice, SoonBadge } from "~/components/ui/states";
import { applyRename } from "~/lib/accounts/rename.server";
import { RENAME_INTERVAL_DAYS } from "~/lib/accounts/usernames";
import { renameStatus } from "~/lib/db/accounts.server";
import { formatDate } from "~/lib/format";
import { setGooglePhoto } from "~/lib/images.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/settings";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Settings · aion.ly" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const status = await renameStatus(env.DB, viewer.id);
  // The one page that shows the account's email, and only to its owner.
  const google = await env.DB.prepare(
    `SELECT "email", "image" IS NOT NULL AS has_photo FROM "user" WHERE "id" = ?1`,
  )
    .bind(viewer.id)
    .first<{ email: string; has_photo: number }>();
  return {
    id: viewer.id,
    username: viewer.username,
    email: google?.email ?? "",
    photoUrl: viewer.avatarKey ? `/img/${viewer.avatarKey}` : undefined,
    hasGooglePhoto: google?.has_photo === 1,
    banned: viewer.ban !== null,
    firstChange: status.firstChange,
    nextChangeAt: status.nextChangeAt,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  const form = await request.formData();

  if (form.get("intent") === "photo") {
    const result = await setGooglePhoto(env.DB, env.IMAGES, {
      userId: viewer.id,
      on: form.get("photo") === "on",
      ownHosts: [new URL(request.url).hostname],
      now: Math.floor(Date.now() / 1000),
    });
    return {
      photoError: result.ok
        ? undefined
        : result.reason === "no_photo"
          ? "Your Google account has no photo to use."
          : "Your Google photo could not be copied. Try again later.",
    };
  }

  const error = await applyRename(viewer.id, String(form.get("username") ?? ""));
  return error ? { error, saved: false } : { error: undefined, saved: true };
}

/** Uses a copy of the Google photo as the avatar, or goes back to the letter. */
function PhotoForm({
  id,
  username,
  photoUrl,
  available,
  disabled,
  error,
}: {
  id: string;
  username: string;
  photoUrl?: string;
  available: boolean;
  disabled: boolean;
  error?: string;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "photo";
  const on = photoUrl !== undefined;

  return (
    <Form method="post" className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="intent" value="photo" />
      <input type="hidden" name="photo" value={on ? "off" : "on"} />
      <Avatar userId={id} username={username} photoUrl={photoUrl} size={40} />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-body font-medium">Profile photo</p>
        <p className="text-meta text-text-muted">
          {on
            ? "A copy of your Google photo. Turning it off deletes the copy."
            : available
              ? "The letter avatar. Your Google photo is shown only if you choose."
              : "The letter avatar. Your Google account has no photo to use."}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-meta text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={disabled || busy || (!on && !available)}>
        {busy ? "Saving…" : on ? "Use the letter" : "Use my Google photo"}
      </Button>
    </Form>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <h2 id={heading} className="flex items-center gap-2 text-title font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { id, username, email, photoUrl, hasGooglePhoto, banned, firstChange, nextChangeAt } = loaderData;
  const renamed = actionData && "saved" in actionData ? actionData : undefined;
  const photo = actionData && "photoError" in actionData ? actionData : undefined;
  const hint = firstChange
    ? `Your first change can be made now. After that, once every ${RENAME_INTERVAL_DAYS} days. Old names are never reused and redirect to the new one.`
    : nextChangeAt
      ? `You can change it again on ${formatDate(nextChangeAt)}.`
      : `A name can change once every ${RENAME_INTERVAL_DAYS} days. Old names are never reused and redirect to the new one.`;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <h1 className="text-display font-semibold">Settings</h1>

      <Section title="Profile">
        <PhotoForm
          id={id}
          username={username}
          photoUrl={photoUrl}
          available={hasGooglePhoto}
          disabled={banned}
          error={photo?.photoError}
        />
        <div className="border-t border-border pt-3">
          {renamed?.saved ? <Notice>Your name is now {username}.</Notice> : null}
          <UsernameForm
            // A saved name starts the form afresh.
            key={username}
            current={username}
            hint={hint}
            error={renamed?.error}
            submitLabel="Save name"
            disabled={banned || nextChangeAt !== null}
          />
        </div>
      </Section>

      <Section
        title={
          <>
            Linked X account <SoonBadge />
          </>
        }
      >
        <p className="text-body text-text-muted">
          Link your X account through X&apos;s own sign-in to show an X mark beside
          your name and to sign in with X. Nothing is linked unless you choose
          to, so you can stay anonymous.
        </p>
        <Button disabled>Link X account</Button>
      </Section>

      <Section title="Account">
        <dl>
          <dt className="text-body font-medium">Email</dt>
          <dd className="text-body break-all">{email}</dd>
          <dd className="text-meta text-text-muted">
            From the Google account you sign in with. Only you can see it.
          </dd>
        </dl>
        <Form method="post" action="/signout" reloadDocument className="border-t border-border pt-3">
          <Button type="submit">Sign out</Button>
        </Form>
      </Section>
    </main>
  );
}
