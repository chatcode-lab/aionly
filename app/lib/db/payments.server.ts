import { WITHDRAWAL_DAYS } from "../plan";
import { settingSql } from "./setting-sql.server";

/**
 * What members paid, as Stripe reported it, before tax: plan invoices,
 * fresh starts that applied, and short usernames bought. The fund counts
 * the fresh starts, and partners get their share of plan payments alone.
 * Each payment is recorded once, however often Stripe reports it.
 */

export type PaymentKind = "plan" | "fresh_start" | "name";

export interface PaymentInput {
  id: string;
  userId: string;
  kind: PaymentKind;
  amountCents: number;
  currency: string;
  paidAt: number;
  paymentIntent?: string | null;
  /** The invoice it was billed on with others, as the 4-letter username with the plan. */
  invoiceId?: string | null;
}

export async function recordPayment(db: D1Database, input: PaymentInput): Promise<void> {
  await db.batch(paymentStatements(db, input));
}

/**
 * The statements that record a payment. A member's first payment for the
 * plan also sets the invitations the plan gives once, at the number in
 * force, to open when the right of withdrawal has passed.
 */
export function paymentStatements(db: D1Database, input: PaymentInput): D1PreparedStatement[] {
  const amount = Math.max(0, Math.round(input.amountCents));
  return [
    db
      .prepare(
        `INSERT INTO payments (id, user_id, kind, amount_cents, currency, paid_at, payment_intent, invoice_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET payment_intent = COALESCE(payments.payment_intent, excluded.payment_intent),
           invoice_id = COALESCE(payments.invoice_id, excluded.invoice_id)`,
      )
      .bind(
        input.id,
        input.userId,
        input.kind,
        amount,
        input.currency.toLowerCase(),
        input.paidAt,
        input.paymentIntent ?? null,
        input.invoiceId ?? null,
      ),
    // A refund that came first applies now.
    applyRefunds(db, input.id, input.paymentIntent ?? null),
    ...(input.kind === "plan" && amount > 0
      ? [
          db
            .prepare(
              `UPDATE profiles SET paid_invites = ${settingSql("invites_with_plan")}, paid_invites_at = ?2 + ${WITHDRAWAL_DAYS} * 86400
               WHERE user_id = ?1 AND paid_invites IS NULL AND owner_id IS NULL`,
            )
            .bind(input.userId, input.paidAt),
        ]
      : []),
  ];
}

/**
 * The payments billed together with the one whose billing key is `key`
 * (SQL), as SQL on `payments` (`alias`): one invoice's, the payment
 * recorded under the invoice's ID and any that name it, as the 4-letter
 * username bought with the plan does; any other payment is its own. A
 * payment's key is `COALESCE(invoice_id, id)`. Written as two indexed
 * equalities, so finding them reads those few rows, never the ledger
 * (review F85).
 */
const BILLED_WITH = (alias: string, key: string) => `(${alias}.id = ${key} OR ${alias}.invoice_id = ${key})`;

/**
 * Sets the refunded part of the payments named by ID, invoice, or payment
 * intent, and of those billed with them, from the refunds kept for them:
 * the largest share any of their charges was refunded, applied to their
 * amount together, before tax, and given to the plan first, since the
 * 4-letter username billed with it is not refundable (review F80). It
 * follows the refunds kept, which never lower, so it is worked out afresh
 * each time, whichever of a shared invoice's payments was recorded first.
 */
function applyRefunds(db: D1Database, id: string | null, paymentIntent: string | null): D1PreparedStatement {
  const key = "COALESCE(payments.invoice_id, payments.id)";
  // The billing keys touched: the ID itself (a payment's, or an invoice's
  // that a refund names), and those of the payments with that ID or intent.
  const touched = `SELECT ?1
    UNION SELECT COALESCE(touched.invoice_id, touched.id) FROM payments AS touched WHERE touched.id = ?1
    UNION SELECT COALESCE(touched.invoice_id, touched.id) FROM payments AS touched WHERE touched.payment_intent = ?2`;
  return db
    .prepare(
      `UPDATE payments SET refunded_cents = MIN(amount_cents, MAX(0,
         CAST(ROUND(
           (SELECT SUM(member.amount_cents) FROM payments AS member WHERE ${BILLED_WITH("member", key)})
           * COALESCE((SELECT MAX(refund.refunded * 1.0 / refund.paid) FROM refunds AS refund
               WHERE refund.invoice_id = ${key}
                  OR refund.payment_intent IN (SELECT member.payment_intent FROM payments AS member
                       WHERE ${BILLED_WITH("member", key)})), 0)) AS INTEGER)
         - COALESCE((SELECT SUM(earlier.amount_cents) FROM payments AS earlier
             WHERE ${BILLED_WITH("earlier", key)}
               AND (earlier.kind <> 'plan', earlier.id) < (payments.kind <> 'plan', payments.id)), 0)))
       WHERE id IN (${touched}) OR invoice_id IN (${touched})`,
    )
    .bind(id, paymentIntent);
}

/**
 * Keeps a refund as Stripe reports it, per charge: the whole refunded so
 * far, tax included, of the whole paid. A later event that reports less,
 * arriving out of order, lowers nothing. Applies to the payment it refunds,
 * by payment intent, or by invoice once Stripe has named it; a payment
 * recorded later takes it then.
 */
export async function recordRefund(
  db: D1Database,
  input: { chargeId: string; paymentIntent: string; invoiceId?: string | null; refunded: number; paid: number; now: number },
): Promise<void> {
  if (input.paid <= 0) return;
  const refunded = Math.min(Math.max(0, input.refunded), input.paid);
  await db.batch([
    db
      .prepare(
        `INSERT INTO refunds (charge_id, payment_intent, invoice_id, refunded, paid, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (charge_id) DO UPDATE SET refunded = MAX(refunds.refunded, excluded.refunded),
           invoice_id = COALESCE(refunds.invoice_id, excluded.invoice_id), updated_at = excluded.updated_at`,
      )
      .bind(input.chargeId, input.paymentIntent, input.invoiceId ?? null, refunded, input.paid, input.now),
    // The invoice's payment learns its payment intent from the refund.
    db
      .prepare(`UPDATE payments SET payment_intent = ?2 WHERE id = ?1 AND payment_intent IS NULL`)
      .bind(input.invoiceId ?? null, input.paymentIntent),
    applyRefunds(db, input.invoiceId ?? null, input.paymentIntent),
  ]);
}

/** Whether a payment with this payment intent is recorded. */
export async function paymentWithIntent(db: D1Database, paymentIntent: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 FROM payments WHERE payment_intent = ?1`).bind(paymentIntent).first()) !== null;
}
