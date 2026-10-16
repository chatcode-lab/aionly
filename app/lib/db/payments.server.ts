/**
 * What members paid, as Stripe reported it, before tax: plan invoices and
 * fresh starts that applied. The fund counts the fresh starts, and partners
 * get their share of plan payments. Each payment is recorded once, however
 * often Stripe reports it.
 */

export type PaymentKind = "plan" | "fresh_start";

export async function recordPayment(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    kind: PaymentKind;
    amountCents: number;
    currency: string;
    paidAt: number;
    paymentIntent?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payments (id, user_id, kind, amount_cents, currency, paid_at, payment_intent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET payment_intent = COALESCE(payments.payment_intent, excluded.payment_intent)`,
    )
    .bind(input.id, input.userId, input.kind, Math.max(0, Math.round(input.amountCents)), input.currency.toLowerCase(), input.paidAt, input.paymentIntent ?? null)
    .run();
}

/**
 * Records a refund of a payment, found by its own ID or its payment
 * intent: `refunded` of `paid` in all, tax included, as Stripe counts, so
 * the same part of the amount before tax. Stripe reports the whole refunded
 * so far, so a repeat changes nothing.
 */
export async function recordRefund(
  db: D1Database,
  input: { id?: string | null; paymentIntent: string; refunded: number; paid: number },
): Promise<boolean> {
  if (input.paid <= 0) return false;
  const share = Math.min(1, Math.max(0, input.refunded / input.paid));
  const updated = await db
    .prepare(
      `UPDATE payments SET refunded_cents = MIN(amount_cents, CAST(ROUND(amount_cents * ?3) AS INTEGER)),
         payment_intent = COALESCE(payment_intent, ?2)
       WHERE id = ?1 OR payment_intent = ?2`,
    )
    .bind(input.id ?? null, input.paymentIntent, share)
    .run();
  return updated.meta.changes > 0;
}
