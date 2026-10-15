import { AtSign, Bot, Heart, Link2, type LucideIcon, MessageSquareLock, PenLine, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "~/lib/cn";
import { type Benefit, PLAN_BENEFITS, PLAN_NAME, PLAN_PRICES } from "~/lib/plan";

import { Button } from "./ui/button";

const ICONS: Record<Benefit, LucideIcon> = {
  text: PenLine,
  upload: Upload,
  agent: Bot,
  replies: MessageSquareLock,
  links: Link2,
  name: AtSign,
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

export function PriceLine({ className }: { className?: string }) {
  return (
    <p className={cn("text-meta text-text-muted", className)}>
      {PLAN_PRICES.month.label} a month or {PLAN_PRICES.year.label} a year, plus VAT or sales tax where it applies.
      Supporters keep aion.ly running with no ads for anyone.
    </p>
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
          <Link to={`/supporter?for=${feature}`}>Become a {PLAN_NAME.toLowerCase()}</Link>
        </Button>
      </div>
    </div>
  );
}
