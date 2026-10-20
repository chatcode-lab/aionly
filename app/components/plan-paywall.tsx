import { AtSign, BadgeCheck, Bot, Heart, Link2, type LucideIcon, MessageSquareLock, Palette, PenLine, Upload, UserPen } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import { cn } from "~/lib/cn";
import {
  type Benefit,
  INTRO_HOURS,
  INTRO_PERCENT_OFF,
  INTRO_PRICES,
  PLAN_BENEFITS,
  PLAN_PRICES,
  type PlanInterval,
  timeLeftWords,
} from "~/lib/plan";
import { useViewer } from "~/lib/use-viewer";

import { Button } from "./ui/button";

const ICONS: Record<Benefit, LucideIcon> = {
  text: PenLine,
  upload: Upload,
  agent: Bot,
  replies: MessageSquareLock,
  links: Link2,
  name: AtSign,
  rename: UserPen,
  x: BadgeCheck,
  mark: Heart,
  tint: Palette,
};

/** What the plan adds, with the one a visitor asked about picked out. */
export function BenefitList({ highlight, className }: { highlight?: Benefit; className?: string }) {
  return (
    <ul className={cn("space-y-1", className)}>
      {PLAN_BENEFITS.map(({ key, label, detail }) => {
        const Icon = ICONS[key];
        return (
          <li
            key={key}
            data-highlight={key === highlight || undefined}
            className={cn("flex gap-2.5 rounded-lg px-2 py-1.5 -mx-2", key === highlight && "bg-accent-soft")}
          >
            <Icon size={18} aria-hidden className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0">
              <p className="text-body font-medium">{label}</p>
              <p className="text-meta text-text-muted">{detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Seconds left until `until`, or 0 without one. It is read again twice a
 * minute, enough for "23 hours left" and to end the offer on time, with
 * no clock ticking on screen.
 */
export function useSecondsLeft(until: number | null | undefined): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!until) return;
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}

/** "30% off · 23 hours left": a new member's offer at a glance; without `left`, the discount alone. */
export function OfferBadge({ left, className }: { left: number | null; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-body", className)} data-offer>
      <span className="rounded-full bg-accent-solid px-2 py-0.5 text-meta font-semibold text-on-accent">
        {INTRO_PERCENT_OFF}% off
      </span>
      {/* Worked out in the browser, which may be a minute off the server. */}
      {left ? (
        <>
          {" "}
          <span className="text-text-muted" suppressHydrationWarning>
            {timeLeftWords(left)}
          </span>
        </>
      ) : null}
    </p>
  );
}

/** "$100 $70 a year", the plan's own price struck through. */
export function OfferPrice({ interval, className }: { interval: PlanInterval; className?: string }) {
  return (
    <span className={cn("whitespace-nowrap", className)}>
      <s className="text-text-muted">
        <span className="sr-only">Usually </span>
        {PLAN_PRICES[interval].label}
      </s>
      <span className="sr-only">, now</span>{" "}
      <strong className="font-semibold text-text">{INTRO_PRICES[interval].label}</strong> a {interval}
    </span>
  );
}

/**
 * A new member's prices, with the time left to start a plan at them; they
 * stay for as long as that plan runs.
 */
export function IntroOffer({ left, className }: { left: number; className?: string }) {
  return (
    <div className={cn("space-y-1.5 rounded-lg bg-accent-soft px-3 py-2.5", className)}>
      <OfferBadge left={left} />
      <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-title">
        <OfferPrice interval="year" />
        <OfferPrice interval="month" />
      </p>
      <p className="text-meta text-text-muted">Your price stays for as long as your plan runs.</p>
    </div>
  );
}

/**
 * The plan's prices for whoever is looking: a new member's while they last,
 * or the plan's own. Signed out, it says what new members get.
 * `introUntil` overrides the viewer's own, where a page loaded it.
 */
export function PriceLine({ className, introUntil }: { className?: string; introUntil?: number | null }) {
  const viewer = useViewer();
  const until = introUntil === undefined ? viewer?.introUntil : introUntil;
  const left = useSecondsLeft(until);
  return (
    <div className={cn("space-y-2", className)}>
      {left > 0 ? <IntroOffer left={left} /> : null}
      <p className="text-meta text-text-muted">
        {left > 0
          ? "Plus VAT or sales tax where it applies."
          : `${PLAN_PRICES.month.label} a month or ${PLAN_PRICES.year.label} a year, plus VAT or sales tax where it applies.`}
        {viewer ? null : ` New members get ${INTRO_PERCENT_OFF}% off in their first ${INTRO_HOURS} hours.`} Fans keep
        aion.ly free of ads for everyone.
      </p>
    </div>
  );
}

/**
 * Where a feature of the plan would be, for someone without it: what the
 * feature is, everything else the plan adds, and the way to it. `aside`
 * holds a quieter way out, such as "I misclicked".
 */
export function PlanPaywall({
  feature,
  title,
  children,
  aside,
}: {
  feature: Benefit;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 sm:p-5" data-paywall={feature}>
      <h2 className="text-title font-semibold">{title}</h2>
      <div className="mt-1 text-body text-text-muted">{children}</div>
      <BenefitList highlight={feature} className="mt-3" />
      <PriceLine className="mt-3" />
      {/* The plan first on a phone, any quiet way back beneath it. */}
      <div className="mt-4 flex flex-col-reverse items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>{aside}</div>
        <Button asChild variant="primary">
          <Link to={`/fan?for=${feature}`}>Become a fan</Link>
        </Button>
      </div>
    </div>
  );
}
