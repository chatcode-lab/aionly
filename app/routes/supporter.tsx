import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { BenefitList, PriceLine } from "~/components/plan-paywall";
import { SupporterMark } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { Notice } from "~/components/ui/states";
import { AlreadySubscribed, billingOpen, BUSY, CheckoutBusy, checkoutUrl, portalUrl } from "~/lib/billing/plan.server";
import { planStatus } from "~/lib/db/subscriptions.server";
import { formatDate } from "~/lib/format";
import { type Benefit, PLAN_BENEFITS, PLAN_NAME, PLAN_PRICES, type PlanInterval } from "~/lib/plan";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant, viewerOf } from "~/lib/viewer.server";
import { standingPageMeta } from "~/lib/meta";

import type { Route } from "./+types/supporter";

export function meta({ matches }: Route.MetaArgs) {
  return standingPageMeta(matches, "supporter");
}

const TROUBLE = "Payments are not working right now. Nothing was charged; try again in a few minutes.";
const START_NOW_MISSING = "Tick the box to start your plan right away, then try again.";

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const asked = url.searchParams.get("for");
  const viewer = await viewerOf(context);
  const status = viewer ? await planStatus(env.DB, viewer.id) : null;
  return {
    feature: PLAN_BENEFITS.find((benefit) => benefit.key === asked)?.key ?? null,
    welcome: url.searchParams.has("welcome"),
    pending: url.searchParams.has("pending"),
    open: billingOpen(),
    signedIn: viewer !== null,
    admin: viewer?.role === "admin",
    supporter: viewer?.supporter ?? false,
    plan: status && viewer?.supporter
      ? { interval: status.interval, periodEnd: status.periodEnd, ending: status.cancelAtPeriodEnd }
      : null,
    hasCustomer: Boolean(status?.customerId),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const origin = new URL(request.url).origin;
  if (!billingOpen()) return { error: "Payments are not open yet." };

  if (form.get("intent") === "portal") {
    const viewer = await requireAccount(request, context);
    if (!(await withinLimits(request, "write", viewer.id))) return { error: RATE_LIMITED_MESSAGE };
    try {
      const url = await portalUrl(viewer, origin);
      if (!url) return { error: "There is no plan to manage yet." };
      return redirect(url, 303);
    } catch (error) {
      console.error("stripe portal", error);
      return { error: TROUBLE };
    }
  }

  // A ban makes the account read-only, so nothing the plan adds would work.
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return { error: RATE_LIMITED_MESSAGE };
  // Already a supporter: changes go through the portal, never a second plan.
  if (viewer.supporter) return { error: "You are already a supporter. Manage your plan below." };
  const interval: PlanInterval = form.get("interval") === "year" ? "year" : "month";
  if (form.get("start_now") !== "yes") return { error: START_NOW_MISSING };
  try {
    return redirect(await checkoutUrl(viewer, interval, origin, Math.floor(Date.now() / 1000)), 303);
  } catch (error) {
    if (error instanceof AlreadySubscribed) return { error: "You already have a plan. Manage it below." };
    if (error instanceof CheckoutBusy) return { error: BUSY };
    console.error("stripe checkout", error);
    return { error: TROUBLE };
  }
}

const FEATURE_TITLE: Record<Benefit, string> = {
  text: "Text posts are for supporters",
  upload: "Uploads are for supporters",
  agent: "Agents are for supporters",
  replies: "Choosing who can reply is for supporters",
  links: "Clickable links are for supporters",
  name: "Short usernames are for supporters",
  mark: "The Supporter mark",
};

export default function Supporter({ loaderData, actionData }: Route.ComponentProps) {
  const { feature, open, signedIn, supporter, plan, admin } = loaderData;
  const [interval, setBilling] = useState<PlanInterval>("year");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formAction === "/supporter";
  const error = actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="flex items-center gap-2 text-display font-semibold">
          {feature ? FEATURE_TITLE[feature] : "Support aion.ly"}
        </h1>
        <p className="mt-1 text-body text-text-muted">
          aion.ly has no ads and never sells data. Supporters pay for its hosting and keep it that way, and get a few
          things in return. Reading, link posts, comments, votes, and saves stay free for everyone.
        </p>
      </div>

      {loaderData.welcome ? (
        <Notice>Thank you for supporting aion.ly. Everything below is switched on for you.</Notice>
      ) : null}
      {loaderData.pending ? (
        <Notice tone="wait">Your payment is being confirmed. This page will show your plan in a minute.</Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
        {supporter ? (
          <>
            <h2 className="flex items-center gap-2 text-title font-semibold">
              You are a supporter <SupporterMark />
            </h2>
            {plan ? (
              <p className="text-body text-text-muted">
                {plan.interval === "year" ? "Yearly" : "Monthly"} plan.{" "}
                {plan.periodEnd
                  ? plan.ending
                    ? `It ends on ${formatDate(plan.periodEnd)}.`
                    : `It renews on ${formatDate(plan.periodEnd)}.`
                  : null}
              </p>
            ) : null}
            {loaderData.hasCustomer ? (
              <Form method="post">
                <Button type="submit" name="intent" value="portal" disabled={!open || busy}>
                  Manage billing
                </Button>
              </Form>
            ) : null}
          </>
        ) : (
          <Form method="post" className="space-y-3">
            <h2 className="text-title font-semibold">{PLAN_NAME}</h2>
            <Segmented
              label="Billing"
              value={interval}
              onChange={setBilling}
              options={[
                { value: "month", label: `${PLAN_PRICES.month.label} a month` },
                { value: "year", label: `${PLAN_PRICES.year.label} a year` },
              ]}
            />
            <input type="hidden" name="interval" value={interval} />
            <PriceLine />
            {interval === "year" ? <p className="text-meta text-text-muted">Yearly is two months free.</p> : null}
            {admin ? <p className="text-meta text-text-muted">As an admin, you have every feature without a plan.</p> : null}
            {signedIn ? (
              <label className="flex items-start gap-2 text-meta text-text-muted">
                <input type="checkbox" name="start_now" value="yes" required className="mt-0.5 size-4 shrink-0 accent-(--accent)" />
                <span>
                  Start my plan right away. I understand that if I withdraw within 14 days, I get my payment back less
                  the days I had the plan.
                </span>
              </label>
            ) : null}
            {signedIn ? (
              <Button type="submit" variant="primary" disabled={!open || busy}>
                {busy ? "Opening checkout…" : open ? "Become a supporter" : "Payments open soon"}
              </Button>
            ) : (
              <Button asChild variant="primary">
                <Link to={`/signin?${new URLSearchParams({ next: "/supporter" })}`}>Sign in to support</Link>
              </Button>
            )}
            <p className="text-meta text-text-muted">
              Paid securely through Stripe. Cancel any time, and the plan runs to the end of the period you paid for.
              See the <Link to="/terms#supporter" className="underline underline-offset-4">terms</Link>.
            </p>
          </Form>
        )}
      </section>

      <section aria-labelledby="benefits" className="rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="benefits" className="mb-2 text-title font-semibold">
          What supporters get
        </h2>
        <BenefitList highlight={feature ?? undefined} />
      </section>
    </main>
  );
}
