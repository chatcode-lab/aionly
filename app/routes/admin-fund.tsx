import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { chooseCause, fundSummary, httpsUrl, recordGift, removeGift } from "~/lib/db/fund.server";
import { CAUSE_NAME_MAX, CAUSE_WHY_MAX, GIFT_NOTE_MAX, URL_MAX } from "~/lib/fund";
import { formatMoney } from "~/lib/format";
import { privatePageMeta } from "~/lib/meta";
import { requireAdmin } from "~/lib/viewer.server";

import type { Route } from "./+types/admin-fund";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Fund · Moderation", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  return { fund: await fundSummary(env.DB) };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** Dollars as typed, "120" or "120.50", in cents. */
function cents(typed: string): number | null {
  const match = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(typed.replace(/,/g, ""));
  if (!match) return null;
  const value = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return value > 0 ? value : null;
}

// Admins only, and unlimited, as moderation is.
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireAdmin(request, context);
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  const intent = form.get("intent");
  if (intent === "cause") {
    const name = text(form, "name");
    const url = httpsUrl(text(form, "url"));
    const why = text(form, "why");
    if (!name || name.length > CAUSE_NAME_MAX) return { error: `Name the cause, in at most ${CAUSE_NAME_MAX} characters.` };
    if (!url) return { error: "The cause's address must be a full https:// address." };
    if (why.length > CAUSE_WHY_MAX) return { error: `Say why in at most ${CAUSE_WHY_MAX} characters.` };
    await chooseCause(env.DB, { name, url, why: why || null, actorId: viewer.id, now });
    return { saved: `The next gift goes to ${name}.` };
  }
  if (intent === "gift") {
    const givenOn = text(form, "given_on");
    const amount = cents(text(form, "amount"));
    const recipient = text(form, "recipient");
    const recipientUrl = httpsUrl(text(form, "recipient_url"));
    const receiptTyped = text(form, "receipt_url");
    const receiptUrl = receiptTyped ? httpsUrl(receiptTyped) : null;
    const note = text(form, "note");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(givenOn) || Number.isNaN(Date.parse(givenOn))) return { error: "Give the day it was given." };
    if (amount === null) return { error: "Give the amount in dollars, such as 120 or 120.50." };
    if (!recipient || recipient.length > CAUSE_NAME_MAX) return { error: `Name who received it, in at most ${CAUSE_NAME_MAX} characters.` };
    if (!recipientUrl) return { error: "The recipient's address must be a full https:// address." };
    if (receiptTyped && !receiptUrl) return { error: "The receipt's address must be a full https:// address." };
    if (note.length > GIFT_NOTE_MAX) return { error: `Keep the note to ${GIFT_NOTE_MAX} characters.` };
    await recordGift(env.DB, { givenOn, amountCents: amount, recipient, recipientUrl, receiptUrl, note: note || null, actorId: viewer.id, now });
    return { saved: `Recorded ${formatMoney(amount)} to ${recipient}.` };
  }
  if (intent === "remove-gift") {
    return (await removeGift(env.DB, text(form, "id"))) ? { saved: "Removed the gift." } : { error: "That gift is not recorded." };
  }
  return { error: "Nothing to do." };
}

/**
 * The fund, for admins: the cause the next gift goes to, and each gift
 * once made, with its receipt, all shown at `/fund`.
 */
export default function AdminFund({ loaderData, actionData }: Route.ComponentProps) {
  const { fund } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const waiting = Math.max(0, fund.collectedCents - fund.givenCents);
  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <AdminHeader current="/admin/fund" />
      {actionData && "saved" in actionData ? <Notice>{actionData.saved}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="danger">{actionData.error}</Notice> : null}
      <p className="text-body text-text-muted">
        Collected {formatMoney(fund.collectedCents)} from {fund.freshStarts} fresh{" "}
        {fund.freshStarts === 1 ? "start" : "starts"}, given {formatMoney(fund.givenCents)}, waiting{" "}
        {formatMoney(waiting)} before card fees. All of it shows at{" "}
        <a href="/fund" className="underline underline-offset-4">
          /fund
        </a>
        .
      </p>

      <Form method="post" className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-title font-semibold">The next gift goes to</h2>
        {fund.cause ? (
          <p className="text-body text-text-muted">
            Now: {fund.cause.name} ({fund.cause.url}){fund.cause.why ? `: ${fund.cause.why}` : ""}
          </p>
        ) : null}
        <input type="hidden" name="intent" value="cause" />
        <TextField label="Cause" name="name" required maxLength={CAUSE_NAME_MAX} />
        <TextField label="Its address" name="url" type="url" required maxLength={URL_MAX} placeholder="https://" />
        <TextField label="Why, in a line" name="why" maxLength={CAUSE_WHY_MAX} />
        <Button type="submit" variant="primary" disabled={busy}>
          Name the cause
        </Button>
      </Form>

      <Form method="post" className="space-y-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-title font-semibold">Record a gift</h2>
        <input type="hidden" name="intent" value="gift" />
        <div className="grid max-w-md grid-cols-2 gap-3">
          <TextField label="Given on" name="given_on" type="date" required />
          <TextField label="Amount, USD" name="amount" inputMode="decimal" required placeholder="120.50" />
        </div>
        <TextField label="Recipient" name="recipient" required maxLength={CAUSE_NAME_MAX} defaultValue={fund.cause?.name} />
        <TextField label="Recipient's address" name="recipient_url" type="url" required maxLength={URL_MAX} defaultValue={fund.cause?.url} />
        <TextField label="Receipt's address" name="receipt_url" type="url" maxLength={URL_MAX} placeholder="A public page or file" />
        <TextField label="Note" name="note" maxLength={GIFT_NOTE_MAX} />
        <Button type="submit" variant="primary" disabled={busy}>
          Record the gift
        </Button>
      </Form>

      {fund.gifts.length > 0 ? (
        <section aria-labelledby="gifts" className="space-y-2">
          <h2 id="gifts" className="text-title font-semibold">
            Gifts
          </h2>
          <ul className="divide-y divide-border">
            {fund.gifts.map((gift) => (
              <li key={gift.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-body">
                <span>
                  {gift.givenOn}: {formatMoney(gift.amountCents)} to {gift.recipient}
                </span>
                <Form method="post">
                  <input type="hidden" name="intent" value="remove-gift" />
                  <input type="hidden" name="id" value={gift.id} />
                  <Button type="submit" disabled={busy}>
                    Remove
                  </Button>
                </Form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
