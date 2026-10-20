-- A plan switch between monthly and yearly, asked for in Settings and made
-- by Stripe at the end of the period paid for: the price it switches to,
-- and when. Read from the subscription's schedule whenever it is applied.
ALTER TABLE subscriptions ADD COLUMN next_price_key TEXT;
ALTER TABLE subscriptions ADD COLUMN next_price_at INTEGER;
