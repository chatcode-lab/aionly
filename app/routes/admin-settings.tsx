import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { type Check, paymentChecks } from "~/lib/billing/check.server";
import { saveSettings, settingHistory, settingsInForce } from "~/lib/db/settings.server";
import { formatAge } from "~/lib/format";
import { privatePageMeta } from "~/lib/meta";
import { sendTestOfferEmails } from "~/lib/offers/offers.server";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { SETTINGS, type SettingGroup, type SettingKey, type Settings, settingSpec } from "~/lib/settings";
import { requireAdmin } from "~/lib/viewer.server";

import type { Route } from "./+types/admin-settings";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Settings · Moderation", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  // The values in force now, not a page's cached copy.
  return {
    values: await settingsInForce(env.DB),
    history: await settingHistory(env.DB),
    now: Math.floor(Date.now() / 1000),
  };
}

type SaveAnswer =
  | { kind: "saved"; saved: string[] }
  | { kind: "problems"; problems: Partial<Record<SettingKey, string>>; typed: Partial<Record<SettingKey, string>> }
  | { kind: "error"; error: string }
  | { kind: "payments"; checks: Check[] }
  | { kind: "mail"; error: string | null };

export async function action({ request, context }: Route.ActionArgs): Promise<SaveAnswer> {
  const viewer = await requireAdmin(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return { kind: "error", error: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  // The checks: whether payments can work here, and whether mail goes out.
  if (form.get("intent") === "check-payments") return { kind: "payments", checks: await paymentChecks() };
  if (form.get("intent") === "test-emails") {
    const error = await sendTestOfferEmails(env.DB, env.EMAIL, {
      userId: viewer.id,
      origin: new URL(request.url).origin,
      secret: env.BETTER_AUTH_SECRET,
    });
    return { kind: "mail", error };
  }
  const values: Partial<Settings> = {};
  const typed: Partial<Record<SettingKey, string>> = {};
  for (const spec of SETTINGS) {
    const raw = String(form.get(spec.key) ?? "").trim();
    typed[spec.key] = raw;
    // Typed as text, so "−5" from a copied page reads as -5.
    values[spec.key] = raw === "" ? Number.NaN : Number(raw.replace(/^[−–]/, "-"));
  }
  const result = await saveSettings(env.DB, { actorId: viewer.id, values, now: Math.floor(Date.now() / 1000) });
  if (!result.ok) {
    return "problems" in result
      ? { kind: "problems", problems: result.problems, typed }
      : { kind: "error", error: "Only an admin can change settings." };
  }
  return { kind: "saved", saved: result.changed.map((key) => settingSpec(key).label) };
}

const GROUPS: SettingGroup[] = ["Karma", "Invitations", "Limits", "Discussions"];

/**
 * The board's numbers, for admins to tune: each with what it does and its
 * default. The whole set is checked before anything is saved; a change
 * that moves stored karma or floors recounts them in the same write.
 */
export default function AdminSettings({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const problems = actionData?.kind === "problems" ? actionData.problems : {};
  const typed = actionData?.kind === "problems" ? actionData.typed : undefined;
  const failed = Object.keys(problems).length > 0;
  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <AdminHeader current="/admin/settings" />
      <p className="text-body text-text-muted">
        The board&apos;s numbers, in force as soon as they are saved. Every write reads the value of its moment; pages
        show a new value within half a minute. Each change is in the log.
      </p>
      {actionData?.kind === "saved" ? (
        <Notice>{actionData.saved.length > 0 ? `Saved: ${actionData.saved.join(", ")}.` : "Nothing changed."}</Notice>
      ) : null}
      {actionData?.kind === "error" ? <Notice tone="danger">{actionData.error}</Notice> : null}
      {failed ? <Notice tone="danger">Nothing was saved. Fix the marked values, then save again.</Notice> : null}

      {/* A failed save keeps what was typed; a new version of the values starts the form afresh. */}
      <Form method="post" className="space-y-4" key={JSON.stringify(loaderData.values)}>
        {GROUPS.map((group) => (
          <section key={group} aria-labelledby={`group-${group}`} className="space-y-4 rounded-xl border border-border bg-surface p-4 sm:p-5">
            <h2 id={`group-${group}`} className="text-title font-semibold">
              {group}
            </h2>
            {SETTINGS.filter((spec) => spec.group === group).map((spec) => (
              <TextField
                key={spec.key}
                name={spec.key}
                label={spec.unit ? `${spec.label} (${spec.unit})` : spec.label}
                hint={`${spec.detail} Default ${spec.default}; ${spec.min} to ${spec.max}.`}
                inputMode="numeric"
                autoComplete="off"
                defaultValue={typed?.[spec.key] ?? String(loaderData.values[spec.key])}
                error={problems[spec.key]}
                className="max-w-40 tabular-nums"
              />
            ))}
          </section>
        ))}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy && !navigation.formData?.get("intent") ? "Saving…" : "Save changes"}
        </Button>
      </Form>

      <Checks answer={actionData} busy={busy ? navigation.formData?.get("intent") : undefined} />

      <section aria-labelledby="changes" className="rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="changes" className="mb-2 text-title font-semibold">
          Recent changes
        </h2>
        {loaderData.history.length === 0 ? (
          <p className="text-body text-text-muted">Every value is its default so far.</p>
        ) : (
          <ul className="divide-y divide-border">
            {loaderData.history.map((entry, index) => (
              <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-body">
                <span>
                  <span className="font-medium">{entry.actor}</span> changed {labelOf(entry.key)}:{" "}
                  <span className="tabular-nums">{entry.change}</span>
                </span>
                <span className="text-meta text-text-muted">{formatAge(entry.at, loaderData.now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * What an admin can try from here without touching anyone's account:
 * whether payments are set up right in this environment, and both offer
 * emails sent to their own sign-in email.
 */
function Checks({ answer, busy }: { answer: SaveAnswer | undefined; busy: FormDataEntryValue | null | undefined }) {
  return (
    <section aria-labelledby="checks" className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <h2 id="checks" className="text-title font-semibold">
        Checks
      </h2>
      <p className="text-body text-text-muted">
        Whether payments are set up here, and whether mail goes out: the welcome and the reminder a new member gets,
        sent to your sign-in email.
      </p>
      <div className="flex flex-wrap gap-2">
        <Form method="post">
          <Button type="submit" name="intent" value="check-payments" disabled={busy !== undefined}>
            {busy === "check-payments" ? "Checking…" : "Check payments"}
          </Button>
        </Form>
        <Form method="post">
          <Button type="submit" name="intent" value="test-emails" disabled={busy !== undefined}>
            {busy === "test-emails" ? "Sending…" : "Send me the offer emails"}
          </Button>
        </Form>
      </div>
      {answer?.kind === "payments" ? (
        <ul className="divide-y divide-border" aria-label="Payment checks">
          {answer.checks.map((check) => (
            <li key={check.label} className="flex flex-wrap items-baseline gap-x-2 py-1.5 text-body">
              <span aria-hidden className={check.ok ? "text-text" : "text-danger"}>
                {check.ok ? "✓" : "✗"}
              </span>
              <span className="font-medium">{check.label}</span>
              <span className="text-text-muted [overflow-wrap:anywhere]">
                <span className="sr-only">{check.ok ? "fine: " : "problem: "}</span>
                {check.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {answer?.kind === "mail" ? (
        answer.error ? (
          <Notice tone="danger">Mail did not go out: {answer.error}</Notice>
        ) : (
          <Notice>Sent both to your sign-in email. Look in spam too if they do not arrive within a few minutes.</Notice>
        )
      ) : null}
    </section>
  );
}

function labelOf(key: string): string {
  return SETTINGS.find((spec) => spec.key === key)?.label.toLowerCase() ?? key;
}
