import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { chooseCause, closeVote, fundSummary, httpsUrl, nominations, postIdOf, recordGift, removeGift, startVote } from "~/lib/db/fund.server";
import { loadSettings } from "~/lib/db/settings.server";
import { CopyButton } from "~/components/sign-in";
import { CAUSE_NAME_MAX, CAUSE_WHY_MAX, GIFT_NOTE_MAX, URL_MAX } from "~/lib/fund";
import { formatDate, formatMoney } from "~/lib/format";
import { privatePageMeta } from "~/lib/meta";
import { requireAdmin } from "~/lib/viewer.server";

import type { Route } from "./+types/admin-fund";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Fund · Admin", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  const fund = await fundSummary(env.DB);
  return {
    fund,
    voteFrom: (await loadSettings(env.DB)).fund_vote_from * 100,
    nominations: fund.vote ? await nominations(env.DB, fund.vote.postId) : [],
    origin: new URL(request.url).origin,
  };
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
    return { saved: `The next gift goes to ${name}${form.get("from_vote") ? ", as members chose; the vote is closed" : ""}.` };
  }
  if (intent === "vote") {
    const postId = postIdOf(text(form, "post"));
    const closesOn = text(form, "closes_on");
    if (!postId) return { error: "Paste the vote post's address, such as https://aion.ly/p/abc1234." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closesOn) || Number.isNaN(Date.parse(closesOn))) return { error: "Give the day nominations close." };
    const closesAt = Date.parse(`${closesOn}T23:59:59Z`) / 1000;
    if (closesAt <= now) return { error: "Nominations close on a day still to come." };
    const result = await startVote(env.DB, { postId, closesAt, actorId: viewer.id, now });
    if (!result.ok) return { error: result.reason === "open_already" ? "A vote is open already." : "There is no live post at that address." };
    return { saved: "The vote is open, and the fund's page points to it." };
  }
  if (intent === "close-vote") {
    return (await closeVote(env.DB, now)) ? { saved: "The vote is closed; open a new one when ready." } : { error: "No vote is open." };
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

      <section className="space-y-3 bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-title font-semibold">Where the next gift goes</h2>
        {fund.vote ? (
          <>
            {fund.vote.post ? (
              <p className="text-body text-text-muted">
                Members {fund.vote.closed ? "chose" : "are choosing"} in{" "}
                <a href={fund.vote.post.path} className="underline underline-offset-4">
                  {fund.vote.post.title}
                </a>
                {fund.vote.closed
                  ? `; nominations closed on ${formatDate(fund.vote.closesAt)}. The result as it closed:`
                  : ` until ${formatDate(fund.vote.closesAt)}. The most voted so far:`}
              </p>
            ) : (
              <Notice tone="warn">The vote&apos;s post is no longer live. Close the vote, then open a new one.</Notice>
            )}
            {loaderData.nominations.length === 0 ? (
              <p className="text-meta text-text-muted">No nominations yet.</p>
            ) : (
              <ol className="list-decimal space-y-1.5 pl-5 text-body">
                {loaderData.nominations.map((entry) => (
                  <li key={entry.id}>
                    <span className="font-medium tabular-nums">{entry.score}</span> · {entry.author}: {entry.text}
                  </li>
                ))}
              </ol>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="close-vote" />
              <Button type="submit" variant="ghost" disabled={busy}>
                Close the vote without a cause
              </Button>
            </Form>
          </>
        ) : (
          <>
            <p className="text-body text-text-muted">
              {waiting >= loaderData.voteFrom
                ? `${formatMoney(waiting)} is waiting: time to let members choose.`
                : `Members choose once ${formatMoney(loaderData.voteFrom)} is waiting (Settings → Fund).`}{" "}
              Post the vote yourself, as a text post, then open it here.
            </p>
            <VoteTemplate waiting={waiting} origin={loaderData.origin} />
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="vote" />
              <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
                <TextField label="The vote post" name="post" required placeholder="https://aion.ly/p/…" />
                <TextField label="Closes on, UTC" name="closes_on" type="date" required />
              </div>
              <Button type="submit" disabled={busy}>
                Open the vote
              </Button>
            </Form>
          </>
        )}
        <Form method="post" className="space-y-3 border-t border-border pt-3">
          <input type="hidden" name="intent" value="cause" />
          {fund.vote ? <input type="hidden" name="from_vote" value="yes" /> : null}
          <p className="text-body font-medium">{fund.vote ? "Name the cause members chose" : "Or name a cause yourself"}</p>
          {fund.cause ? (
            <p className="text-meta text-text-muted">
              Now: {fund.cause.name} ({fund.cause.url}){fund.cause.why ? `: ${fund.cause.why}` : ""}
            </p>
          ) : null}
          <TextField label="Cause" name="name" required maxLength={CAUSE_NAME_MAX} />
          <TextField label="Its address" name="url" type="url" required maxLength={URL_MAX} placeholder="https://" />
          <TextField label="Why, in a line" name="why" maxLength={CAUSE_WHY_MAX} />
          <Button type="submit" variant="primary" disabled={busy}>
            {fund.vote ? "Name it and close the vote" : "Name the cause"}
          </Button>
        </Form>
      </section>

      <Form method="post" className="space-y-3 bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
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

/** A vote post to copy into Submit as a text post. */
function VoteTemplate({ waiting, origin }: { waiting: number; origin: string }) {
  const title = `Where should the aion.ly fund give ${formatMoney(waiting)}?`;
  const body = `Fresh starts have brought ${formatMoney(waiting)} to the aion.ly fund, and members decide where it goes.

Name a cause in a top-level comment: what it does, its address, and why it matters for AI or for people. Vote for the ones you back. When nominations close, the most voted cause gets the gift, and its receipt goes on ${origin}/fund.`;
  return (
    <details className="text-body">
      <summary className="cursor-pointer text-text-muted">A vote post to start from</summary>
      <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
        <p className="font-medium">{title}</p>
        <p className="whitespace-pre-line text-text-muted">{body}</p>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={title} label="Copy title" done="Title copied" className="" />
          <CopyButton text={body} label="Copy text" done="Text copied" className="" />
        </div>
      </div>
    </details>
  );
}
