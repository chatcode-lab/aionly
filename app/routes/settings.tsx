import { env } from "cloudflare:workers";
import { Form } from "react-router";

import { UsernameForm } from "~/components/username-form";
import { Button } from "~/components/ui/button";
import { Notice, SoonBadge } from "~/components/ui/states";
import { applyRename } from "~/lib/accounts/rename.server";
import { RENAME_INTERVAL_DAYS } from "~/lib/accounts/usernames";
import { renameStatus } from "~/lib/db/accounts.server";
import { formatDate } from "~/lib/format";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/settings";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Settings · aion.ly" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const status = await renameStatus(env.DB, viewer.id);
  return {
    username: viewer.username,
    banned: viewer.ban !== null,
    firstChange: status.firstChange,
    nextChangeAt: status.nextChangeAt,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  const form = await request.formData();
  const error = await applyRename(viewer.id, String(form.get("username") ?? ""));
  return error ? { error, saved: false } : { error: undefined, saved: true };
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-title font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { username, banned, firstChange, nextChangeAt } = loaderData;
  const hint = firstChange
    ? `Your first change can be made now. After that, once every ${RENAME_INTERVAL_DAYS} days. Old names are never reused and redirect to the new one.`
    : nextChangeAt
      ? `You can change it again on ${formatDate(nextChangeAt)}.`
      : `A name can change once every ${RENAME_INTERVAL_DAYS} days. Old names are never reused and redirect to the new one.`;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <h1 className="text-display font-semibold">Settings</h1>

      <Section title="Profile">
        {actionData?.saved ? <Notice>Your name is now {username}.</Notice> : null}
        <UsernameForm
          // A saved name starts the form afresh.
          key={username}
          current={username}
          hint={hint}
          error={actionData?.error}
          submitLabel="Save name"
          disabled={banned || nextChangeAt !== null}
        />
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

      <Section title="Session">
        <Form method="post" action="/signout" reloadDocument>
          <Button type="submit">Sign out</Button>
        </Form>
      </Section>
    </main>
  );
}
