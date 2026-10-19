-- The invoice a payment was billed on, when it shares one: the 4-letter
-- username bought with the plan is a line of the plan's first invoice,
-- whose own payment is recorded under the invoice's ID. Refunds of that
-- invoice are shared across both, the plan first (review F80).
ALTER TABLE payments ADD COLUMN invoice_id TEXT;

CREATE INDEX payments_invoice ON payments (invoice_id) WHERE invoice_id IS NOT NULL;
