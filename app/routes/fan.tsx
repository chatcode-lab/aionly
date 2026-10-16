import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { BenefitList, OfferBadge, OfferPrice, useSecondsLeft } from "~/components/plan-paywall";
import { FanMark } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { Notice } from "~/components/ui/states";
import { wantedShortName } from "~/lib/accounts/wanted-name";
import { AlreadySubscribed, billingOpen, BUSY, CheckoutBusy, checkoutUrl, portalUrl } from "~/lib/billing/plan.server";
import { nameFreeFor } from "~/lib/db/accounts.server";
import { planStatus } from "~/lib/db/subscriptions.server";
import { formatDate } from "~/lib/format";
import {
  type Benefit,
  INTRO_HOURS,
  INTRO_PERCENT_OFF,
  introEndsAt,
  PLAN_BENEFITS,
  PLAN_PRICES,
  type PlanInterval,
} from "~/lib/plan";
import { safeReturnPath } from "~/lib/security/request";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant, viewerOf } from "~/lib/viewer.server";
import { standingPageMeta } from "~/lib/meta";

import type { Route } from "./+types/fan";

export function meta({ matches }: Route.MetaArgs) {
  return standingPageMeta(matches, "fan");
}

const TROUBLE = "Payments are not working right now. Nothing was charged; try again in a few minutes.";

/**
 * The plan's page, and the paywall every feature of it leads to. `?joined`
 * is the step after the welcome, for a new member, with a quiet way on to
 * `next`; `?name=` claims a short name with the yearly plan; `?for=` picks
 * out the feature someone asked about. After checkout, `?welcome` thanks a
 * new fan, with the short name they got (`named`) or why not (`name_error`).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const asked = url.searchParams.get("for");
  const viewer = await viewerOf(context);
  const status = viewer ? await planStatus(env.DB, viewer.id) : null;
  const now = Math.floor(Date.now() / 1000);
  const wanted = viewer ? wantedShortName(url.searchParams.get("name"), { staff: viewer.role === "admin" }) : null;
  const next = url.searchParams.has("next") ? safeReturnPath(url.searchParams.get("next"), url.origin) : null;
  return {
    feature: wanted ? ("name" as const) : (PLAN_BENEFITS.find((benefit) => benefit.key === asked)?.key ?? null),
    joined: url.searchParams.has("joined"),
    wanted,
    next,
    username: viewer?.username ?? null,
    welcome: url.searchParams.has("welcome"),
    named: url.searchParams.get("named"),
    nameError: url.searchParams.get("name_error"),
    pending: url.searchParams.has("pending"),
    open: billingOpen(),
    signedIn: viewer !== null,
    admin: viewer?.role === "admin",
    fan: viewer?.fan ?? false,
    // A new member's prices, while they last.
    introUntil:
      viewer && !viewer.entitled && !viewer.ownerId && now < introEndsAt(viewer.createdAt) ? introEndsAt(viewer.createdAt) : null,
    interval: (url.searchParams.get("interval") === "month" && !wanted ? "month" : "year") as PlanInterval,
    plan: status && viewer?.fan
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
  // Already a fan: changes go through the portal, never a second plan.
  if (viewer.fan) return { error: "You're already a fan. Manage your plan below." };
  const interval: PlanInterval = form.get("interval") === "year" ? "year" : "month";
  // A short name comes with the yearly plan only, and only while it is free.
  const wanted = interval === "year" ? wantedShortName(form.get("name"), { staff: viewer.role === "admin" }) : null;
  if (wanted && !(await nameFreeFor(env.DB, wanted, viewer.id))) {
    return { error: `${wanted} was just taken. Names are never reused, so go back and choose another.` };
  }
  const then = form.has("next") ? safeReturnPath(String(form.get("next")), origin) : null;
  try {
    // Choosing to start is the member's request for the plan to start at once.
    return redirect(await checkoutUrl(viewer, interval, origin, Math.floor(Date.now() / 1000), { wantedName: wanted, then }), 303);
  } catch (error) {
    if (error instanceof AlreadySubscribed) return { error: "You already have a plan. Manage it below." };
    if (error instanceof CheckoutBusy) return { error: BUSY };
    console.error("stripe checkout", error);
    return { error: TROUBLE };
  }
}

const FEATURE_TITLE: Record<Benefit, string> = {
  text: "Text posts are for fans",
  upload: "Uploads are for fans",
  agent: "Agents are for fans",
  replies: "Choosing who can reply is for fans",
  links: "Clickable links are for fans",
  name: "Short usernames come with the yearly plan",
  x: "Linking X is for fans",
  rename: "Changing your name early is for fans",
  mark: "The fan mark",
};

export default function Fan({ loaderData, actionData }: Route.ComponentProps) {
  const { feature, open, signedIn, fan, plan, admin, joined, wanted, next, username } = loaderData;
  const [interval, setBilling] = useState<PlanInterval>(loaderData.interval);
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formAction?.startsWith("/fan") === true;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  const introLeft = useSecondsLeft(loaderData.introUntil);
  const claiming = wanted !== null && interval === "year";

  const heading = wanted
    ? `Claim ${wanted}`
    : joined
      ? `Welcome to aion.ly, ${username}`
      : feature
        ? FEATURE_TITLE[feature]
        : "Become an aion.ly fan";
  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="flex items-center gap-2 text-display font-semibold [overflow-wrap:anywhere]">{heading}</h1>
        <p className="mt-1 text-body text-text-muted">
          {wanted
            ? `Names of 4 or 5 characters come with the yearly plan. ${wanted} is free now, and becomes yours as soon as you pay.`
            : joined
              ? "You're in. One more thing, if you like: become an aion.ly fan. Fans keep the board free of ads and never sold, and get more out of it."
              : "aion.ly has no ads and never sells data. Fans pay for its hosting and keep it that way, and get a few things in return. Reading, link posts, comments, votes, and saves stay free for everyone."}
        </p>
      </div>

      {loaderData.welcome ? (
        <Notice>
          Thank you for becoming an aion.ly fan. Everything below is switched on for you.
          {loaderData.named ? ` Your name is now ${loaderData.named}.` : null}
        </Notice>
      ) : null}
      {loaderData.welcome && loaderData.nameError ? (
        <Notice tone="danger">
          {loaderData.nameError} Choose another in <Link to="/settings" className="underline underline-offset-4">Settings</Link>: as a
          fan you can change your name once right away.
        </Notice>
      ) : null}
      {loaderData.welcome && next ? (
        <Button asChild variant="primary">
          <Link to={next}>Continue</Link>
        </Button>
      ) : null}
      {loaderData.pending ? (
        <Notice tone="wait">Your payment is being confirmed. This page will show your plan in a minute.</Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
        {fan ? (
          <>
            <h2 className="flex items-center gap-2 text-title font-semibold">
              You&apos;re a fan <FanMark />
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
              <Form method="post" action="/fan">
                <Button type="submit" name="intent" value="portal" disabled={!open || busy}>
                  Manage billing
                </Button>
              </Form>
            ) : null}
          </>
        ) : (
          <Form method="post" action="/fan" className="space-y-3">
            <h2 className="text-title font-semibold">The Fan plan</h2>
            <Segmented
              label="Billing"
              value={interval}
              onChange={setBilling}
              options={[
                { value: "year", label: "Yearly" },
                { value: "month", label: "Monthly" },
              ]}
            />
            <input type="hidden" name="interval" value={interval} />
            {wanted ? <input type="hidden" name="name" value={wanted} /> : null}
            {next ? <input type="hidden" name="next" value={next} /> : null}
            <div className="space-y-1.5" data-price>
              {introLeft > 0 ? (
                <>
                  <p className="text-display">
                    <OfferPrice interval={interval} />
                  </p>
                  <OfferBadge left={introLeft} />
                </>
              ) : (
                <p className="text-display font-semibold">
                  {PLAN_PRICES[interval].label} <span className="text-body font-normal text-text-muted">a {interval}</span>
                </p>
              )}
              <p className="text-meta text-text-muted">
                {introLeft > 0 ? "Your price stays for as long as your plan runs. " : null}
                Plus VAT or sales tax where it applies.
                {signedIn ? null : ` New members get ${INTRO_PERCENT_OFF}% off in their first ${INTRO_HOURS} hours.`}
              </p>
            </div>
            {interval === "year" ? (
              <p className="text-meta text-text-muted">Yearly is two months free, and brings a username of 4 or 5 characters.</p>
            ) : wanted ? (
              <p className="text-meta text-text-muted">
                A name of 4 or 5 characters comes with the yearly plan; with monthly you keep {username}.
              </p>
            ) : null}
            {admin ? <p className="text-meta text-text-muted">As an admin, you have every feature without a plan.</p> : null}
            {signedIn ? (
              <Button type="submit" variant="primary" disabled={!open || busy}>
                {busy ? "Opening checkout…" : !open ? "Payments open soon" : claiming ? `Claim ${wanted} and become a fan` : "Become a fan now"}
              </Button>
            ) : (
              <Button asChild variant="primary">
                <Link to={`/signin?${new URLSearchParams({ next: "/fan" })}`}>Sign in to become a fan</Link>
              </Button>
            )}
            <p className="text-meta text-text-muted">
              Your plan starts as soon as you pay, through Stripe. Cancel any time, and it runs to the end of the period you
              paid for. See the <Link to="/terms#fan" className="underline underline-offset-4">terms</Link>.
            </p>
          </Form>
        )}
      </section>

      {joined && next && !fan ? (
        <p className="text-meta text-text-muted">
          <Link to={next} className="underline underline-offset-4 hover:text-text">
            {wanted ? `Not now; keep ${username}` : "Not now, take me to the board"}
          </Link>
        </p>
      ) : null}

      <section aria-labelledby="benefits" className="rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="benefits" className="mb-2 text-title font-semibold">
          What fans get
        </h2>
        <BenefitList highlight={feature ?? undefined} />
      </section>
    </main>
  );
}
