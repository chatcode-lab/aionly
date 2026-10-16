import { AtSign, BadgeCheck, Bot, Heart, Link2, type LucideIcon, MessageSquareLock, PenLine, Upload, UserPen } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import { cn } from "~/lib/cn";
import { type Benefit, INTRO_HOURS, INTRO_PRICES, PLAN_BENEFITS, PLAN_PRICES } from "~/lib/plan";
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

/** Seconds left until `until`, ticking each second, or 0 without one. */
export function useSecondsLeft(until: number | null | undefined): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}

/** 23:04:09 */
function clock(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/**
 * A new member's prices, with the time left to start a plan at them; they
 * stay for as long as that plan runs.
 */
export function IntroOffer({ left, className }: { left: number; className?: string }) {
  return (
    <div className={cn("rounded-lg bg-accent-soft px-3 py-2 text-body text-text", className)}>
      <p>
        <strong className="font-semibold">New-member price</strong> for{" "}
        {/* The clock runs in the browser, a second or so off the server's. */}
        <time className="font-mono tabular-nums" suppressHydrationWarning>
          {clock(left)}
        </time>{" "}
        more: {INTRO_PRICES.month.label} a month instead of {PLAN_PRICES.month.label}, or {INTRO_PRICES.year.label} a
        year instead of {PLAN_PRICES.year.label}.
      </p>
      <p className="text-meta text-text-muted">The price you start at stays for as long as your plan runs.</p>
    </div>
  );
}

/**
 * The plan's prices for whoever is looking: a new member's while they last,
 * counting down, or the plan's own. Signed out, it says what new members
 * get. `introUntil` overrides the viewer's own, where a page loaded it.
 */
export function PriceLine({ className, introUntil }: { className?: string; introUntil?: number | null }) {
  const viewer = useViewer();
  const until = introUntil === undefined ? viewer?.introUntil : introUntil;
  const left = useSecondsLeft(until);
  const prices = left > 0 ? INTRO_PRICES : PLAN_PRICES;
  return (
    <div className={cn("space-y-2", className)}>
      {left > 0 ? <IntroOffer left={left} /> : null}
      <p className="text-meta text-text-muted">
        {prices.month.label} a month or {prices.year.label} a year, plus VAT or sales tax where it applies.
        {viewer
          ? null
          : ` New members pay ${INTRO_PRICES.month.label} or ${INTRO_PRICES.year.label} for a plan they start within ${INTRO_HOURS} hours of joining.`}{" "}
        Fans keep aion.ly running with no ads for anyone.
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
