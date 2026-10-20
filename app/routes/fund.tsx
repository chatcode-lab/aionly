import { env } from "cloudflare:workers";
import { Link } from "react-router";

import { fundSummary } from "~/lib/db/fund.server";
import { loadSettings } from "~/lib/db/settings.server";
import { formatDate, formatMoney } from "~/lib/format";
import { pageMeta } from "~/lib/meta";
import { FRESH_START_PRICE } from "~/lib/plan";

import type { Route } from "./+types/fund";
import { profilePath } from "~/lib/slug";

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, {
    title: "The fund",
    description: "Every fresh start's payment goes to a cause members choose: what came in, where it went, and the receipts.",
    path: "/fund",
  });
}

export async function loader() {
  return { fund: await fundSummary(env.DB), voteFrom: (await loadSettings(env.DB)).fund_vote_from * 100 };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 2026", from "2026-10". */
function monthName(month: string): string {
  const [year, number] = month.split("-");
  return `${MONTHS[Number(number) - 1] ?? month} ${year}`;
}

/** "14 October 2026", from "2026-10-14". */
function dayName(day: string): string {
  const [year, month, date] = day.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

const LINK = "font-medium text-text underline underline-offset-4";

/**
 * Where fresh starts' money goes: to charity, given once a month, every
 * gift listed with its receipt. Open to everyone.
 */
export default function Fund({ loaderData }: Route.ComponentProps) {
  const { fund } = loaderData;
  const waiting = Math.max(0, fund.collectedCents - fund.givenCents);
  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <div className="space-y-2">
        <h1 className="text-display font-semibold">The fund</h1>
        <p className="text-body text-text-muted">
          When an account&apos;s karma falls to the floor, a{" "}
          <Link to="/fresh-start" className={LINK}>
            fresh start
          </Link>{" "}
          lets it take part again, for {FRESH_START_PRICE.label} or whatever more its member chooses. We keep none of it:
          whenever enough has gathered, members choose a cause in a post here, and we give it all, less card fees, with
          the receipt below.
        </p>
      </div>

      <section aria-labelledby="cause" className="space-y-1 bleed rounded-xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="cause" className="text-title font-semibold">
          The next gift
        </h2>
        {fund.vote?.post ? (
          <p className="text-body text-text-muted">
            {fund.vote.closed ? "Members chose it in " : "Members are choosing it now: name a cause or vote for one in "}
            <Link to={fund.vote.post.path} className={LINK}>
              {fund.vote.post.title}
            </Link>
            {fund.vote.closed
              ? `. Nominations closed on ${formatDate(fund.vote.closesAt)}, and the result is named here soon.`
              : `, until ${formatDate(fund.vote.closesAt)}.`}
          </p>
        ) : fund.vote ? (
          <p className="text-body text-text-muted">Members are choosing it; the result is named here soon.</p>
        ) : fund.cause ? (
          <p className="text-body text-text-muted">
            Goes to{" "}
            <a href={fund.cause.url} rel="noopener" className={LINK}>
              {fund.cause.name}
            </a>
            {fund.cause.why ? `: ${fund.cause.why}` : ""}
            {fund.cause.vote ? (
              <>
                {", as members chose in "}
                <Link to={fund.cause.vote.path} className={LINK}>
                  {fund.cause.vote.title}
                </Link>
              </>
            ) : null}
            .
          </p>
        ) : (
          <p className="text-body text-text-muted">
            Members choose it in a post here once {formatMoney(loaderData.voteFrom)} has gathered.
          </p>
        )}
      </section>

      <section aria-labelledby="totals" className="space-y-3">
        <h2 id="totals" className="text-title font-semibold">
          So far
        </h2>
        {fund.freshStarts === 0 ? (
          <p className="text-body text-text-muted">Nothing yet: no fresh start has been paid for.</p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Figure label="Collected" value={formatMoney(fund.collectedCents)} detail={`${fund.freshStarts} fresh ${fund.freshStarts === 1 ? "start" : "starts"}, before card fees`} />
              <Figure label="Given" value={formatMoney(fund.givenCents)} detail={`${fund.gifts.length} ${fund.gifts.length === 1 ? "gift" : "gifts"}`} />
              <Figure label="For the next gift" value={formatMoney(waiting)} detail="Less card fees when given" />
            </dl>
            <table className="w-full text-body">
              <caption className="sr-only">Fresh starts by month</caption>
              <thead>
                <tr className="text-left text-meta text-text-muted">
                  <th scope="col" className="py-1.5 font-medium">
                    Month
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Fresh starts
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Collected
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border">
                {fund.months.map((month) => (
                  <tr key={month.month}>
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {monthName(month.month)}
                    </th>
                    <td className="py-1.5 text-right tabular-nums">{month.freshStarts}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoney(month.collectedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-labelledby="gifts" className="space-y-3">
        <h2 id="gifts" className="text-title font-semibold">
          Gifts
        </h2>
        {fund.gifts.length === 0 ? (
          <p className="text-body text-text-muted">None yet. The first comes at the end of the first month with a fresh start.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {fund.gifts.map((gift) => (
              <li key={gift.id} className="space-y-0.5 py-3">
                <p className="text-body">
                  <strong>{formatMoney(gift.amountCents)}</strong> to{" "}
                  <a href={gift.recipientUrl} rel="noopener" className={LINK}>
                    {gift.recipient}
                  </a>
                </p>
                <p className="text-meta text-text-muted">
                  {dayName(gift.givenOn)}
                  {gift.receiptUrl ? (
                    <>
                      {" "}
                      ·{" "}
                      <a href={gift.receiptUrl} rel="noopener" className="underline underline-offset-4">
                        Receipt
                      </a>
                    </>
                  ) : null}
                  {gift.note ? ` · ${gift.note}` : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {fund.givers.length > 0 ? (
        <section aria-labelledby="givers" className="space-y-1">
          <h2 id="givers" className="text-title font-semibold">
            Members who show their gift
          </h2>
          <p className="text-body text-text-muted">
            {fund.givers.map((name, index) => (
              <span key={name}>
                {index > 0 ? ", " : null}
                <Link to={profilePath(name)} className="font-medium text-text hover:underline">
                  {name}
                </Link>
              </span>
            ))}
          </p>
        </section>
      ) : null}

      <p className="text-meta text-text-muted">
        Amounts are before VAT. A fresh start is a purchase from us, so it carries no tax receipt; the gift is ours.{" "}
        <Link to="/terms#fresh-start" className="underline underline-offset-4">
          Terms
        </Link>
      </p>
    </main>
  );
}

function Figure({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <dt className="text-meta text-text-muted">{label}</dt>
      <dd className="text-display font-semibold tabular-nums">{value}</dd>
      <dd className="text-meta text-text-muted">{detail}</dd>
    </div>
  );
}
