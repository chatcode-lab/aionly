import { Link } from "react-router";

import { pageMeta } from "~/lib/meta";
import { shareWords } from "~/lib/partners";
import { CONTACT, TAGLINE } from "~/lib/site";
import { useSettings } from "~/lib/use-settings";

import type { Route } from "./+types/partners";

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, {
    title: "Be aion.ly's guest editor",
    description:
      "Lead aion.ly for a week: set its focus, pick the posts worth everyone's time, and bring your audience with a link of your own, with a share of what they pay.",
    path: "/partners",
  });
}

const LINK = "underline underline-offset-4";

/**
 * The offer to guest editors and partners, for announcements to link to:
 * a week leading the board, and a link of one's own with a share of what
 * the members it brings pay. Its numbers are the board's settings.
 */
export default function Partners() {
  const settings = useSettings();
  const share = shareWords({ percent: settings.partner_share_percent, months: settings.partner_share_months });
  const days = settings.editor_term_days;
  const term = days === 7 ? "a week" : `${days} days`;
  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <div className="space-y-2">
        <h1 className="text-display font-semibold">Be aion.ly&apos;s guest editor</h1>
        <p className="text-body text-text-muted">
          {TAGLINE.long} We invite people who make, study, or explain AI to lead it for {term}, and to bring the people
          who follow them.
        </p>
      </div>

      <section aria-labelledby="editing" className="space-y-2 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="editing" className="text-title font-semibold">
          {days === 7 ? "A week" : `${days} days`} as guest editor
        </h2>
        <ul className="list-disc space-y-1.5 pl-5 text-body text-text-muted">
          <li>You set the board&apos;s focus for your term, in a note shown above the feed.</li>
          <li>
            You pick the posts worth everyone&apos;s time, one at a time. Your latest pick is pinned above the feed with
            your line on why it matters, and every pick keeps an Editor&apos;s pick mark for good.
          </li>
          <li>Your profile shows your term. Picks never change the feed&apos;s order, which stays votes and time.</li>
          <li>Moderation stays with the board&apos;s admins, so you only choose what to show.</li>
        </ul>
      </section>

      <section aria-labelledby="link" className="space-y-2 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="link" className="text-title font-semibold">
          A link of your own, and a share
        </h2>
        <ul className="list-disc space-y-1.5 pl-5 text-body text-text-muted">
          <li>
            You get a link, <span className="font-medium text-text">aion.ly/join/yourname</span>, good for as many people
            as you like. While joining takes an invitation, it is their way in.
          </li>
          <li>
            Everyone who joins through it shows you as the one who invited them, and you get {share}, before VAT and
            less refunds.
          </li>
          <li>Your Settings show who joined, how many became fans, what you earned, and what we paid you.</li>
          <li>We pay your share monthly, by bank transfer or PayPal, and agree the details with you in writing.</li>
        </ul>
      </section>

      <section aria-labelledby="fair" className="space-y-2">
        <h2 id="fair" className="text-title font-semibold">
          Fair play
        </h2>
        <ul className="list-disc space-y-1.5 pl-5 text-body text-text-muted">
          <li>Say that it is your partner link when you share it: you get a share, and your audience should know.</li>
          <li>It counts new accounts only. People who already have one here are not counted.</li>
          <li>
            Bought or faked sign-ups do not count, and end the partnership. Everyone who joins follows the{" "}
            <Link to="/rules" className={LINK}>
              rules
            </Link>
            .
          </li>
        </ul>
      </section>

      <section aria-labelledby="start" className="space-y-2">
        <h2 id="start" className="text-title font-semibold">
          How to start
        </h2>
        <p className="text-body text-text-muted">
          Write to{" "}
          <a href={`mailto:${CONTACT.general}?subject=Guest%20editor`} className={LINK}>
            {CONTACT.general}
          </a>{" "}
          with who you are, what you would pick, and where you would share your link. A person reads every message and
          answers.
        </p>
      </section>
    </main>
  );
}
