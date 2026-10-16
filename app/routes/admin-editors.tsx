import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { editorTerms, endTerm, forgetEditor, nameEditor } from "~/lib/db/editors.server";
import { loadSettings } from "~/lib/db/settings.server";
import { formatDate } from "~/lib/format";
import { privatePageMeta } from "~/lib/meta";
import { requireAdmin } from "~/lib/viewer.server";

import type { Route } from "./+types/admin-editors";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Editors · Moderation", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  return {
    terms: await editorTerms(env.DB),
    days: (await loadSettings(env.DB)).editor_term_days,
    now: Math.floor(Date.now() / 1000),
  };
}

const DAY = 24 * 3600;

// Admins only, and unlimited, as moderation is.
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireAdmin(request, context);
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  if (form.get("intent") === "name") {
    const username = String(form.get("username") ?? "").trim();
    const startsOn = String(form.get("starts_on") ?? "").trim();
    const typedDays = String(form.get("days") ?? "").trim();
    const days = typedDays === "" ? (await loadSettings(env.DB)).editor_term_days : Number(typedDays);
    if (!username) return { error: "Name the member who will edit." };
    if (!Number.isInteger(days) || days < 1 || days > 365) return { error: "The term is a whole number of days, 1 to 365." };
    if (startsOn && (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || Number.isNaN(Date.parse(startsOn)))) {
      return { error: "Give the day it starts, or leave it blank to start now." };
    }
    // A day starts at midnight UTC; blank starts now.
    const startsAt = startsOn ? Math.max(now, Date.parse(`${startsOn}T00:00:00Z`) / 1000) : now;
    const result = await nameEditor(env.DB, { username, startsAt, endsAt: startsAt + days * DAY, actorId: viewer.id, now });
    forgetEditor();
    if (!result.ok) {
      return {
        error: result.reason === "no_member" ? `There is no member named ${username}.` : "That term overlaps another. One editor at a time.",
      };
    }
    return { saved: `${username} edits from ${formatDate(startsAt)} to ${formatDate(startsAt + days * DAY)}.` };
  }
  if (form.get("intent") === "end") {
    const ended = await endTerm(env.DB, { termId: String(form.get("term") ?? ""), now });
    forgetEditor();
    return ended ? { saved: "The term is over." } : { error: "That term is over already." };
  }
  return { error: "Nothing to do." };
}

/**
 * Guest editors, for admins: name a member to lead the board for a term,
 * one at a time, and end a term early. The editor picks posts and sets the
 * focus; moderation stays with admins.
 */
export default function AdminEditors({ loaderData, actionData }: Route.ComponentProps) {
  const { terms, days, now } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <AdminHeader current="/admin/editors" />
      {actionData && "saved" in actionData ? <Notice>{actionData.saved}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="danger">{actionData.error}</Notice> : null}
      <p className="text-body text-text-muted">
        While their term runs, the guest editor sets the board&apos;s focus, shown above the feed, and picks posts from
        their ⋯ menus: the latest pick is pinned above the feed, and every pick keeps an Editor&apos;s pick mark. They do
        not moderate. <a href="/partners" className="underline underline-offset-4">/partners</a> describes the offer;
        give them a partner link too.
      </p>

      <Form method="post" className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-title font-semibold">Name a guest editor</h2>
        <input type="hidden" name="intent" value="name" />
        <TextField label="Member's username" name="username" required autoComplete="off" />
        <div className="flex flex-wrap gap-3">
          <TextField label="Starts on" name="starts_on" type="date" hint="Blank starts now; a day starts at midnight UTC." />
          <TextField label="Days" name="days" inputMode="numeric" placeholder={String(days)} className="max-w-28" />
        </div>
        <Button type="submit" variant="primary" disabled={busy}>
          Name the editor
        </Button>
      </Form>

      <section aria-labelledby="terms" className="space-y-2">
        <h2 id="terms" className="text-title font-semibold">
          Terms
        </h2>
        {terms.length === 0 ? (
          <p className="text-body text-text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {terms.map((term) => {
              const state = term.startsAt > now ? "to come" : term.endsAt > now ? "editing now" : "over";
              return (
                <li key={term.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-body">
                  <span>
                    <span className="font-medium">{term.username}</span>, {formatDate(term.startsAt)} to {formatDate(term.endsAt)} ·{" "}
                    {state} · {term.picks} {term.picks === 1 ? "pick" : "picks"}
                    {term.focus ? <span className="text-text-muted"> · {term.focus}</span> : null}
                  </span>
                  {term.endsAt > now ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="end" />
                      <input type="hidden" name="term" value={term.id} />
                      <Button type="submit" disabled={busy}>
                        {term.startsAt > now ? "Drop" : "End now"}
                      </Button>
                    </Form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
