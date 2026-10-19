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
        `INSERT INTO payments (id, user_id, kind, amount_cents, currency, paid_at, payment_intent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET payment_intent = COALESCE(payments.payment_intent, excluded.payment_intent)`,
      )
      .bind(input.id, input.userId, input.kind, amount, input.currency.toLowerCase(), input.paidAt, input.paymentIntent ?? null),
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
 * Sets the refunded part of the payments named by ID or payment intent from
 * the refunds kept for them: the largest share any of their charges was
 * refunded, applied to the amount before tax, and never lowered.
 */
function applyRefunds(db: D1Database, id: string | null, paymentIntent: string | null): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE payments SET refunded_cents = MAX(refunded_cents, MIN(amount_cents, COALESCE((
         SELECT CAST(ROUND(payments.amount_cents * MAX(refund.refunded * 1.0 / refund.paid)) AS INTEGER)
         FROM refunds AS refund
         WHERE refund.payment_intent = payments.payment_intent OR refund.invoice_id = payments.id), 0)))
       WHERE id = ?1 OR payment_intent = ?2`,
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
