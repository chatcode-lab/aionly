import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { CopyButton } from "~/components/sign-in";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import {
  createPartnerLink,
  partnerLinks,
  joinedThrough,
  partnersOwed,
  recordPayout,
  revokePartnerLink,
} from "~/lib/db/partners.server";
import { loadSettings } from "~/lib/db/settings.server";
import { formatDate, formatMoney } from "~/lib/format";
import { privatePageMeta } from "~/lib/meta";
import { normalizePartnerCode, PARTNER_STEPS_MAX, type PartnerStep, partnerStepsProblem, stepsLabel } from "~/lib/partners";
import { requireAdmin } from "~/lib/viewer.server";

import type { Route } from "./+types/admin-partners";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Partners · Admin", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  const now = Math.floor(Date.now() / 1000);
  const links = await partnerLinks(env.DB, { now });
  return {
    links,
    joined: await joinedThrough(env.DB, links.map((link) => link.code)),
    owed: await partnersOwed(env.DB, now),
    settings: await loadSettings(env.DB),
    origin: new URL(request.url).origin,
  };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** A whole number typed in a range, or null; blank is `blank`. */
function whole(typed: string, min: number, max: number, blank: number | null = null): number | null | undefined {
  if (typed === "") return blank;
  const value = Number(typed);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/** Dollars as typed, "120" or "120.50", in cents. */
function cents(typed: string): number | null {
  const match = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(typed.replace(/,/g, ""));
  if (!match) return null;
  const value = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return value > 0 ? value : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Admins only, and unlimited, as moderation is.
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireAdmin(request, context);
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  const intent = form.get("intent");
  if (intent === "link") {
    const partner = text(form, "partner");
    const code = normalizePartnerCode(text(form, "code") || partner.replace(/^@/, ""));
    // Each filled row is a step; blank months, the last step's, last for good.
    const steps: PartnerStep[] = [];
    for (let index = 1; index <= PARTNER_STEPS_MAX; index += 1) {
      const percent = text(form, `step${index}_percent`);
      const months = text(form, `step${index}_months`);
      if (percent === "" && months === "") continue;
      steps.push({ percent: percent === "" ? Number.NaN : Number(percent), months: months === "" ? null : Number(months) });
    }
    const freeInvites = whole(text(form, "free_invites"), 0, 1_000);
    const maxUses = whole(text(form, "max_uses"), 1, 1_000_000);
    const endsOn = text(form, "ends_on");
    if (!partner) return { error: "Name the partner's account." };
    if (!code) return { error: "The link's name: 3 to 30 lowercase letters, digits, _ and -." };
    const stepsProblem = partnerStepsProblem(steps);
    if (stepsProblem) return { error: stepsProblem };
    if (freeInvites === undefined) return { error: "Free invitations are a whole number, 0 to 1000, or blank for each level's." };
    if (maxUses === undefined) return { error: "The limit is a whole number of accounts, or blank for none." };
    if (endsOn && (!DAY.test(endsOn) || Number.isNaN(Date.parse(endsOn)))) return { error: "Give the day it ends, or leave it blank." };
    const endsAt = endsOn ? Date.parse(`${endsOn}T23:59:59Z`) / 1000 : null;
    const problem = await createPartnerLink(env.DB, {
      code,
      partner,
      steps,
      freeInvites,
      maxUses,
      endsAt,
      note: text(form, "note").slice(0, 280) || null,
      actorId: viewer.id,
      now,
    });
    if (problem === "taken") return { error: `A link named ${code} exists already. Choose another name.` };
    if (problem === "no_partner") return { error: `There is no member named ${partner}.` };
    return { saved: `Made /join/${code}.` };
  }
  if (intent === "revoke") {
    return (await revokePartnerLink(env.DB, { code: text(form, "code"), now }))
      ? { saved: "The link no longer takes sign-ups. Those who joined keep counting." }
      : { error: "That link is revoked already." };
  }
  if (intent === "payout") {
    const amount = cents(text(form, "amount"));
    const paidOn = text(form, "paid_on");
    const partnerId = text(form, "partner_id");
    if (!partnerId) return { error: "Choose the partner." };
    if (amount === null) return { error: "Give the amount in dollars, such as 120 or 120.50." };
    if (!DAY.test(paidOn) || Number.isNaN(Date.parse(paidOn))) return { error: "Give the day it was paid." };
    await recordPayout(env.DB, { partnerId, amountCents: amount, paidOn, note: text(form, "note").slice(0, 280) || null, actorId: viewer.id, now });
    return { saved: `Recorded a payout of ${formatMoney(amount)}.` };
  }
  return { error: "Nothing to do." };
}

/**
 * Partners, for admins: their links, made here for a member's account with
 * the share and months fixed, what each brought, and the payouts of each
 * partner's share, which their own Settings show them too.
 */
export default function AdminPartners({ loaderData, actionData }: Route.ComponentProps) {
  const { links, owed, settings, origin } = loaderData;
  const joined = new Map(loaderData.joined);
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <AdminHeader current="/admin/partners" />
      {actionData && "saved" in actionData ? <Notice>{actionData.saved}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="danger">{actionData.error}</Notice> : null}
      <p className="text-body text-text-muted">
        Everyone who joins through a link is invited by its partner, who gets the link&apos;s share of their plan
        payments, before VAT and refunds, never of the Short username package.{" "}
        <a href="/partners" className="underline underline-offset-4">The offer</a>
      </p>

      <Form method="post" className="space-y-3 bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-title font-semibold">Make a link</h2>
        <input type="hidden" name="intent" value="link" />
        <TextField label="Partner's username" name="partner" required autoComplete="off" />
        <TextField label="Link name" name="code" placeholder="The username" autoComplete="off" />
        <fieldset className="space-y-2">
          <legend className="text-body font-medium">Share of plan payments</legend>
          {Array.from({ length: PARTNER_STEPS_MAX }, (_, index) => (
            <div key={index} className="grid grid-cols-2 gap-3 sm:max-w-md">
              <TextField
                label={index === 0 ? "First, %" : "Then, %"}
                name={`step${index + 1}_percent`}
                inputMode="numeric"
                defaultValue={index === 0 ? String(settings.partner_share_percent) : undefined}
              />
              <TextField
                label="For months"
                name={`step${index + 1}_months`}
                inputMode="numeric"
                placeholder="For good"
                defaultValue={index === 0 ? String(settings.partner_share_months) : undefined}
              />
            </div>
          ))}
          <p className="text-meta text-text-muted">Months after each member joins. Leave the last step&apos;s months blank to share for good.</p>
        </fieldset>
        <div className="space-y-2">
          {/* Inputs line up even where a label wraps. */}
          <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
            <TextField label="Free invitations each" name="free_invites" inputMode="numeric" defaultValue="0" placeholder="By level" />
            <TextField label="Accounts" name="max_uses" inputMode="numeric" placeholder="No limit" />
            <TextField label="Ends on" name="ends_on" type="date" />
          </div>
          <p className="text-meta text-text-muted">Leave free invitations blank to give each member their level&apos;s.</p>
        </div>
        <TextField label="Note for admins" name="note" maxLength={280} placeholder="What was agreed" />
        <Button type="submit" variant="primary" disabled={busy}>
          Make the link
        </Button>
      </Form>

      {owed.length > 0 ? (
        <Form method="post" className="space-y-3 bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
          <h2 className="text-title font-semibold">Shares</h2>
          <ul className="divide-y divide-border">
            {owed.map((partner) => (
              <li key={partner.partnerId} className="flex flex-wrap justify-between gap-2 py-1.5 text-body">
                <span className="font-medium">{partner.partner}</span>
                <span className="text-text-muted tabular-nums">
                  earned {formatMoney(partner.earnedCents)} · paid {formatMoney(partner.paidCents)} · owed{" "}
                  {formatMoney(Math.max(0, partner.earnedCents - partner.paidCents))}
                </span>
              </li>
            ))}
          </ul>
          <input type="hidden" name="intent" value="payout" />
          <label className="block text-body font-medium">
            Partner
            <Select
              name="partner_id"
              required
              frame="mt-1 w-full max-w-sm"
              block
              className="h-10 rounded-lg border border-border-strong bg-surface pl-2 text-body font-normal text-text pointer-coarse:h-(--touch)"
            >
              {owed.map((partner) => (
                <option key={partner.partnerId} value={partner.partnerId}>
                  {partner.partner}
                </option>
              ))}
            </Select>
          </label>
          <div className="grid max-w-md grid-cols-2 gap-3">
            <TextField label="Amount, USD" name="amount" inputMode="decimal" required />
            <TextField label="Paid on" name="paid_on" type="date" required />
          </div>
          <TextField label="Note" name="note" maxLength={280} placeholder="How it was paid" />
          <Button type="submit" variant="primary" disabled={busy}>
            Record the payout
          </Button>
        </Form>
      ) : null}

      <section aria-labelledby="links" className="space-y-2">
        <h2 id="links" className="text-title font-semibold">
          Links
        </h2>
        {links.length === 0 ? (
          <p className="text-body text-text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {links.map((link) => {
              return (
                <li key={link.code} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-body font-medium [overflow-wrap:anywhere]">
                      /join/{link.code} · {link.partner}
                      {link.live ? null : <span className="text-text-muted"> · {link.revokedAt !== null ? "revoked" : "ended"}</span>}
                    </span>
                    <span className="flex gap-2">
                      <CopyButton text={`${origin}/join/${link.code}`} label="Copy link" done="Link copied" className="" />
                      {link.revokedAt === null ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="revoke" />
                          <input type="hidden" name="code" value={link.code} />
                          <Button type="submit" disabled={busy}>
                            Revoke
                          </Button>
                        </Form>
                      ) : null}
                    </span>
                  </div>
                  <p className="text-meta text-text-muted">
                    {stepsLabel(link.steps)} ·{" "}
                    {link.freeInvites === null ? "invitations by level" : `${link.freeInvites} free invitations each`} · {link.joined} joined
                    {link.maxUses !== null ? ` of ${link.maxUses}` : ""} · {link.fans} fans now · paid{" "}
                    {formatMoney(link.revenueCents)}, earned {formatMoney(link.earnedCents)}
                    {link.endsAt !== null ? ` · ends ${formatDate(link.endsAt)}` : ""}
                    {link.note ? ` · ${link.note}` : ""}
                  </p>
                  {joined.get(link.code)?.length ? (
                    <details className="text-meta">
                      <summary className="cursor-pointer text-text-muted">Who joined</summary>
                      <p className="mt-1 text-text-muted">
                        {joined.get(link.code)!.map((member, index) => (
                          <span key={member.username}>
                            {index > 0 ? ", " : null}
                            <a href={`/u/${member.username}`} className="font-medium text-text hover:underline">
                              {member.username}
                            </a>
                            {member.fan ? " (fan)" : null}
                          </span>
                        ))}
                      </p>
                    </details>
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
