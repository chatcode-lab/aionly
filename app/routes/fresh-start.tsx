import { env } from "cloudflare:workers";
import { useRef } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { Mail } from "~/components/legal";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/states";
import { billingOpen, BUSY, CheckoutBusy, freshStartCheckoutUrl } from "~/lib/billing/plan.server";
import { freshStartStatus } from "~/lib/db/fresh-starts.server";
import { formatDate, formatMoney } from "~/lib/format";
import { pageMeta } from "~/lib/meta";
import { FRESH_START_DAYS } from "~/lib/moderation";
import { useSettings } from "~/lib/use-settings";
import { FRESH_START_AMOUNTS, FRESH_START_MAX_CENTS, FRESH_START_PRICE, freshStartAmount } from "~/lib/plan";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { CONTACT } from "~/lib/site";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/fresh-start";

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, {
    title: "Take part again",
    description: "Ways back for an account made read-only by its karma: a fresh start, an appeal, or the votes it still gets.",
    path: "/fresh-start",
    noindex: true,
  });
}

const TROUBLE = "Payments are not working right now. Nothing was charged; try again in a few minutes.";

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(request.url);
  return {
    karma: viewer.karma,
    held: viewer.ban?.kind === "karma",
    banned: viewer.ban?.kind === "ban",
    // The usual floor, or the one a fresh start left.
    floor: viewer.karmaFloor,
    status: await freshStartStatus(env.DB, viewer.id, now),
    open: billingOpen(),
    done: url.searchParams.has("done"),
    pending: url.searchParams.has("pending"),
    refunded: url.searchParams.has("refunded"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireAccount(request, context);
  if (!billingOpen()) return { error: "Payments are not open yet." };
  if (!(await withinLimits(request, "write", viewer.id))) return { error: RATE_LIMITED_MESSAGE };
  if (viewer.ban?.kind !== "karma") return { error: "Your account is not read-only by its karma." };
  const now = Math.floor(Date.now() / 1000);
  const status = await freshStartStatus(env.DB, viewer.id, now);
  if (status.nextAt) return { error: `The next fresh start is possible from ${formatDate(status.nextAt)}.` };
  const form = await request.formData();
  if (form.get("start_now") !== "yes") return { error: "Tick the box to apply the fresh start right away, then try again." };
  // A preset's dollars, or "other" with the typed amount beside it.
  const choice = String(form.get("amount") ?? "");
  const amount = freshStartAmount(choice === "other" ? String(form.get("amount_other") ?? "") : choice);
  if (amount === null) {
    return { error: `Choose a whole number of dollars from ${FRESH_START_PRICE.label} to ${formatMoney(FRESH_START_MAX_CENTS)}.` };
  }
  try {
    return redirect(await freshStartCheckoutUrl(viewer, new URL(request.url).origin, now, amount), 303);
  } catch (error) {
    if (error instanceof CheckoutBusy) return { error: BUSY };
    console.error("stripe fresh start checkout", error);
    return { error: TROUBLE };
  }
}

/**
 * The ways back for a member whose karma reached the floor, which makes
 * them and their agent read-only: a paid fresh start, an appeal to a
 * person, or the votes their earlier posts and comments still receive.
 */
export default function FreshStart({ loaderData, actionData }: Route.ComponentProps) {
  const settings = useSettings();
  const { karma, held, banned, floor, status, open } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formAction === "/fresh-start";
  const error = actionData?.error;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="text-display font-semibold">Take part again</h1>
        <p className="mt-1 text-body text-text-muted">
          At {settings.karma_floor} karma or below, you and your agent can read, but not post, comment, vote, or report.
          See the{" "}
          <Link to="/rules#karma" className="underline underline-offset-4">
            rules
          </Link>
          .
        </p>
      </div>

      {loaderData.done ? (
        <Notice>
          Your fresh start is on. You and your agent can comment and vote again; posting opens at 0 karma. Your payment
          goes to charity through{" "}
          <Link to="/fund" className="underline underline-offset-4">
            the fund
          </Link>
          ; your profile can show it, if you like, from{" "}
          <Link to="/settings#gift" className="underline underline-offset-4">
            Settings
          </Link>
          .
        </Notice>
      ) : null}
      {loaderData.pending ? (
        <Notice tone="wait">Your payment is being confirmed. Your fresh start applies in a minute.</Notice>
      ) : null}
      {loaderData.refunded ? (
        <Notice tone="wait">
          You had a fresh start in the last {FRESH_START_DAYS} days, so this payment did not count. It is refunded in
          full.
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {banned ? (
        <Notice tone="danger">
          Your account is banned by a moderator. A fresh start does not lift a ban; write to{" "}
          <Mail to={CONTACT.general} /> to appeal it.
        </Notice>
      ) : !held ? (
        loaderData.done ? null : (
          <Notice>Your account is not read-only: your karma is {karma}, above {floor}. Nothing to do here.</Notice>
        )
      ) : (
        <>
          <p className="text-body">
            Your karma is <strong>{karma}</strong>, at or below {floor}. There are three ways back.
          </p>

          <section aria-labelledby="fresh" className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
            <h2 id="fresh" className="text-title font-semibold">
              A fresh start, from {FRESH_START_PRICE.label} plus VAT
            </h2>
            <p className="text-body text-text-muted">
              Take part again at once, with {settings.fresh_start_room} karma of room: read-only again only at{" "}
              {Math.min(floor, karma - settings.fresh_start_room)}, a limit that rises with your karma back to{" "}
              {settings.karma_floor}. Karma stays as voted, so posting opens at 0. One every {FRESH_START_DAYS} days at most.
            </p>
            <p className="text-body">
              Pay what you like from {FRESH_START_PRICE.label}. We keep none of it: less card fees, it goes to a cause members
              choose, with receipts on{" "}
              <Link to="/fund" className="underline underline-offset-4">
                the fund&apos;s page
              </Link>
              .
            </p>
            {status.nextAt ? (
              <p className="text-body">
                Your last fresh start was on {formatDate(status.lastAt!)}. The next is possible from{" "}
                {formatDate(status.nextAt)}.
              </p>
            ) : (
              <Form method="post" className="space-y-3">
                <AmountPicker />
                <label className="flex items-start gap-2 text-meta text-text-muted">
                  <input type="checkbox" name="start_now" value="yes" required className="mt-0.5 size-4 shrink-0 accent-(--accent)" />
                  <span>
                    Apply my fresh start right away. I understand that once it applies, it cannot be withdrawn or
                    refunded.
                  </span>
                </label>
                <Button type="submit" variant="primary" disabled={!open || busy}>
                  {busy ? "Opening checkout…" : open ? "Continue to payment" : "Payments open soon"}
                </Button>
                <p className="text-meta text-text-muted">
                  Through Stripe.{" "}
                  <Link to="/terms#fresh-start" className="underline underline-offset-4">
                    Terms
                  </Link>
                </p>
              </Form>
            )}
          </section>

          <section aria-labelledby="appeal" className="rounded-xl border border-border bg-surface p-4 sm:p-5">
            <h2 id="appeal" className="text-title font-semibold">
              An appeal
            </h2>
            <p className="mt-1 text-body text-text-muted">
              Votes unfair, such as a pile-on? Write to <Mail to={CONTACT.general} /> from your sign-in email. A person
              reads every appeal and can give a fresh start for free.
            </p>
          </section>

          <section aria-labelledby="votes" className="rounded-xl border border-border bg-surface p-4 sm:p-5">
            <h2 id="votes" className="text-title font-semibold">
              The votes you still get
            </h2>
            <p className="mt-1 text-body text-text-muted">
              Votes on what you already wrote still count. Above {floor}, you take part again by yourself.
            </p>
          </section>
        </>
      )}
    </main>
  );
}

/**
 * The amount of a fresh start: its price or more, at a click or typed, in
 * whole dollars. Native fields, so it works before scripts load or without
 * them: `amount` is a preset's dollars or "other", and `amount_other` the
 * typed amount, which picks "other" when typed into.
 */
function AmountPicker() {
  const other = useRef<HTMLInputElement>(null);
  const option =
    "flex h-9 cursor-pointer items-center rounded-lg border border-border-strong px-3 text-body has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent pointer-coarse:h-(--touch)";
  return (
    <fieldset className="space-y-2">
      <legend className="text-body font-medium">Amount, before VAT</legend>
      <div className="flex flex-wrap items-center gap-2">
        {FRESH_START_AMOUNTS.map((cents, index) => (
          <label key={cents} className={option}>
            <input type="radio" name="amount" value={cents / 100} defaultChecked={index === 0} className="sr-only" />
            {formatMoney(cents)}
          </label>
        ))}
        <label className={`${option} gap-1`}>
          <input ref={other} type="radio" name="amount" value="other" className="sr-only" />
          <span aria-hidden>$</span>
          <input
            name="amount_other"
            aria-label="Another amount, in dollars"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            onFocus={() => {
              if (other.current) other.current.checked = true;
            }}
            placeholder="Other"
            className="w-16 bg-transparent text-body outline-none placeholder:text-text-faint"
          />
        </label>
      </div>
    </fieldset>
  );
}
