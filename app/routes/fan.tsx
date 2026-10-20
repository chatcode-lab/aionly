import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { BenefitList, OfferBadge, OfferPrice, useSecondsLeft } from "~/components/plan-paywall";
import { FanMark } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { Notice } from "~/components/ui/states";
import { YEARLY_USERNAME_MIN } from "~/lib/accounts/usernames";
import { wantedShortName } from "~/lib/accounts/wanted-name";
import {
  AlreadyHasName,
  AlreadySubscribed,
  NamePending,
  billingOpen,
  BUSY,
  CheckoutBusy,
  checkoutUrl,
  nameCheckoutUrl,
  portalUrl,
} from "~/lib/billing/plan.server";
import { nameFreeFor } from "~/lib/db/accounts.server";
import { planStatus } from "~/lib/db/subscriptions.server";
import { formatDate } from "~/lib/format";
import {
  type Benefit,
  INTRO_HOURS,
  INTRO_PERCENT_OFF,
  introEndsAt,
  NAME_ALLOWANCES,
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
 * `next`; `?name=` claims a short name, of 5 characters with the yearly
 * plan or of 4 with the 4-letter username, bought once, alone or with the
 * plan; `?for=` picks out the feature someone asked about. After checkout,
 * `?welcome` thanks a new fan and `?bought` a member who bought the name
 * alone, with the short name they got (`named`) or why not (`name_error`).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const asked = url.searchParams.get("for");
  const viewer = await viewerOf(context);
  const status = viewer ? await planStatus(env.DB, viewer.id) : null;
  const now = Math.floor(Date.now() / 1000);
  const wanted = viewer ? wantedShortName(url.searchParams.get("name"), { staff: viewer.role === "admin" }) : null;
  const next = url.searchParams.has("next") ? safeReturnPath(url.searchParams.get("next"), url.origin) : null;
  // A name shorter than the yearly plan allows is bought once, by its length.
  const allowance = wanted && wanted.length < YEARLY_USERNAME_MIN ? (NAME_ALLOWANCES[wanted.length] ?? null) : null;
  return {
    feature: wanted ? ("name" as const) : (PLAN_BENEFITS.find((benefit) => benefit.key === asked)?.key ?? null),
    joined: url.searchParams.has("joined"),
    wanted,
    next,
    username: viewer?.username ?? null,
    welcome: url.searchParams.has("welcome"),
    bought: url.searchParams.has("bought"),
    allowance: allowance ? { label: allowance.label } : null,
    // The member may take the name already, with the 4-letter username bought or as an admin.
    nameAllowed: viewer !== null && wanted !== null && viewer.shortestName <= wanted.length,
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
    interval: (url.searchParams.get("interval") === "month" && (!wanted || allowance) ? "month" : "year") as PlanInterval,
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
  const then = form.has("next") ? safeReturnPath(String(form.get("next")), origin) : null;

  // A short username bought once, alone or with the plan.
  if (form.get("intent") === "name") {
    const wanted = wantedShortName(form.get("name"), { staff: viewer.role === "admin" });
    if (!wanted || !NAME_ALLOWANCES[wanted.length]) return { error: "Choose a name of 4 characters in Settings first." };
    if (viewer.shortestName <= wanted.length) return { error: `You can take ${wanted} already, in Settings.` };
    if (form.get("start_now") !== "yes") return { error: "Tick the box to make the name yours right away, then try again." };
    const plan = form.get("with");
    const interval: PlanInterval | null = plan === "year" || plan === "month" ? plan : null;
    if (interval && viewer.fan) return { error: "You're already a fan. Buy the name alone." };
    if (!(await nameFreeFor(env.DB, wanted, viewer.id))) {
      return { error: `${wanted} was just taken. Names are never reused, so go back and choose another.` };
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      return redirect(await nameCheckoutUrl(viewer, { length: wanted.length, wantedName: wanted, interval, origin, startNowAt: now, then }), 303);
    } catch (error) {
      if (error instanceof AlreadyHasName) return { error: `You have it already. Take ${wanted} in Settings.` };
      if (error instanceof NamePending) return { error: "Your earlier payment for it is still being confirmed. Try again once it is." };
      if (error instanceof AlreadySubscribed) return { error: "You already have a plan. Buy the name alone." };
      if (error instanceof CheckoutBusy) return { error: BUSY };
      console.error("stripe name checkout", error);
      return { error: TROUBLE };
    }
  }

  // Already a fan: changes go through the portal, never a second plan.
  if (viewer.fan) return { error: "You're already a fan. Manage your plan below." };
  const interval: PlanInterval = form.get("interval") === "year" ? "year" : "month";
  // A short name comes with the yearly plan only, 5 characters, and only while it is free.
  const named = interval === "year" ? wantedShortName(form.get("name"), { staff: viewer.role === "admin" }) : null;
  const wanted = named && named.length >= YEARLY_USERNAME_MIN ? named : null;
  if (wanted && !(await nameFreeFor(env.DB, wanted, viewer.id))) {
    return { error: `${wanted} was just taken. Names are never reused, so go back and choose another.` };
  }
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

/**
 * The 4-letter username, bought once, for good: alone, or with the plan
 * for a member without one. Like a fresh start, it is provided as soon as
 * it is paid for, so the member asks for that, and acknowledges that the
 * payment cannot then be withdrawn, with a box.
 */
function NameForm({
  wanted,
  price,
  fan,
  open,
  busy,
  next,
  introLeft,
}: {
  wanted: string;
  price: string;
  /** Has the plan already, or needs none. */
  fan: boolean;
  open: boolean;
  busy: boolean;
  next: string | null;
  introLeft: number;
}) {
  const [plan, setPlan] = useState<"none" | PlanInterval>("none");
  return (
    <Form method="post" action="/fan" className="space-y-3">
      <h2 className="text-title font-semibold">The 4-letter username add-on</h2>
      <input type="hidden" name="intent" value="name" />
      <input type="hidden" name="name" value={wanted} />
      <input type="hidden" name="with" value={plan} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="space-y-1.5" data-price>
        <p className="text-display font-semibold">
          {price} <span className="text-body font-normal text-text-muted">once</span>
        </p>
        <p className="text-meta text-text-muted">Plus VAT or sales tax where it applies. Yours for good, with or without the plan.</p>
      </div>
      {fan ? null : (
        <div className="space-y-1.5">
          <Segmented
            label="With the Fan plan"
            value={plan}
            onChange={setPlan}
            options={[
              { value: "none", label: "Name only" },
              { value: "year", label: "+ Yearly" },
              { value: "month", label: "+ Monthly" },
            ]}
          />
          {plan === "none" ? null : (
            <p className="text-body">
              and{" "}
              {introLeft > 0 ? (
                <OfferPrice interval={plan} />
              ) : (
                <>
                  <span className="font-semibold">{PLAN_PRICES[plan].label}</span> a {plan}
                </>
              )}{" "}
              for the plan, which starts as soon as you pay.
            </p>
          )}
        </div>
      )}
      <label className="flex items-start gap-2 text-meta text-text-muted">
        <input type="checkbox" name="start_now" value="yes" required className="mt-0.5 size-4 shrink-0 accent-(--accent)" />
        <span>
          Make {wanted} mine right away. I understand that once it is mine, the {price} cannot be withdrawn or
          refunded.
        </span>
      </label>
      <Button type="submit" variant="primary" disabled={!open || busy}>
        {busy
          ? "Opening checkout…"
          : !open
            ? "Payments open soon"
            : plan === "none"
              ? `Claim ${wanted} for ${price}`
              : `Claim ${wanted} and become a fan`}
      </Button>
      <p className="text-meta text-text-muted">
        Through Stripe. Without a plan in force, a name of 5 characters or fewer is no longer certain: it may go to
        someone who asks for it, after notice and time to renew.{" "}
        <Link to="/terms#names" className="underline underline-offset-4">
          Terms
        </Link>
      </p>
    </Form>
  );
}

const FEATURE_TITLE: Record<Benefit, string> = {
  text: "Text posts are for fans",
  upload: "Uploads are for fans",
  agent: "Agents are for fans",
  replies: "Choosing who can reply is for fans",
  links: "Clickable links are for fans",
  name: "A 5-character username comes with the yearly plan",
  x: "Linking X is for fans",
  rename: "Changing your name early is for fans",
  mark: "The fan mark",
};

export default function Fan({ loaderData, actionData }: Route.ComponentProps) {
  const { feature, open, signedIn, fan, plan, admin, joined, wanted, next, username, allowance } = loaderData;
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
          {wanted && loaderData.nameAllowed
            ? `${wanted} is free, and you can take it in Settings.`
            : wanted && allowance
            ? `${wanted} is free, and yours for good with the 4-letter username add-on, bought once, apart from the Fan plan.`
            : wanted
            ? `${wanted} is free, and yours as soon as you pay for the yearly plan.`
            : joined
              ? "You're in. Fans keep the board free of ads, and get more out of it."
              : "No ads, and no data sold: fans pay for the hosting and get a few extras. Reading, link posts, comments, votes, and saves stay free for everyone."}
        </p>
      </div>

      {loaderData.welcome ? (
        <Notice>
          Thank you for becoming an aion.ly fan. Everything below is switched on for you.
          {loaderData.named ? ` Your name is now ${loaderData.named}.` : null}
        </Notice>
      ) : null}
      {loaderData.bought ? (
        <Notice>
          The 4-letter username add-on is yours for good.
          {loaderData.named ? ` Your name is now ${loaderData.named}.` : null}
        </Notice>
      ) : null}
      {loaderData.bought && loaderData.nameError ? (
        <Notice tone="danger">
          {loaderData.nameError} Choose another in <Link to="/settings" className="underline underline-offset-4">Settings</Link>.
        </Notice>
      ) : null}
      {loaderData.bought && next ? (
        <Button asChild variant="primary">
          <Link to={next}>Continue</Link>
        </Button>
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

      <section className="space-y-3 bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
        {wanted && allowance && !loaderData.nameAllowed && !loaderData.bought ? (
          signedIn ? (
            <NameForm wanted={wanted} price={allowance.label} fan={fan || admin} open={open} busy={busy} next={next} introLeft={introLeft} />
          ) : null
        ) : fan ? (
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
                {introLeft > 0 ? "Your price stays while your plan runs. " : null}
                Plus VAT or sales tax where it applies.
                {signedIn ? null : ` New members get ${INTRO_PERCENT_OFF}% off in their first ${INTRO_HOURS} hours.`}
              </p>
            </div>
            {interval === "year" ? (
              <p className="text-meta text-text-muted">Yearly is two months free, and brings a username of 5 characters.</p>
            ) : wanted ? (
              <Notice tone="warn">
                <span className="font-medium">Monthly does not include {wanted}.</span> Names of 5 characters come
                with the yearly plan only; with monthly you keep {username}.{" "}
                <button type="button" onClick={() => setBilling("year")} className="font-medium underline underline-offset-4">
                  Switch to yearly
                </button>
              </Notice>
            ) : null}
            {admin ? <p className="text-meta text-text-muted">As an admin, you have every feature without a plan.</p> : null}
            {signedIn ? (
              <Button type="submit" variant="primary" disabled={!open || busy}>
                {busy
                  ? "Opening checkout…"
                  : !open
                    ? "Payments open soon"
                    : claiming
                      ? `Claim ${wanted} and become a fan`
                      : wanted
                        ? `Become a fan without ${wanted}`
                        : "Become a fan now"}
              </Button>
            ) : (
              <Button asChild variant="primary">
                <Link to={`/signin?${new URLSearchParams({ next: "/fan" })}`}>Sign in to become a fan</Link>
              </Button>
            )}
            <p className="text-meta text-text-muted">
              Your plan starts as soon as you pay, through Stripe. Cancel any time; it runs to the end of the paid period.{" "}
              <Link to="/terms#fan" className="underline underline-offset-4">Terms</Link>
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

      <section aria-labelledby="benefits" className="bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="benefits" className="mb-2 text-title font-semibold">
          What fans get
        </h2>
        <BenefitList highlight={feature ?? undefined} />
      </section>
    </main>
  );
}
