-- Emails about a new member's offer: a welcome as the account is made, and
-- a reminder a few hours before the new member's price ends.
-- `offer_emails` counts those claimed for sending (0, 1, or 2), so each
-- goes once. Accounts made before this have had their day, so are done.
ALTER TABLE profiles ADD COLUMN offer_emails INTEGER NOT NULL DEFAULT 0 CHECK (offer_emails IN (0, 1, 2));
UPDATE profiles SET offer_emails = 2;

-- Whether the member takes emails about offers and the Fan plan: on until
-- they opt out, in Settings or by any such email's unsubscribe link.
ALTER TABLE profiles ADD COLUMN offers_email INTEGER NOT NULL DEFAULT 1 CHECK (offers_email IN (0, 1));

-- The few accounts still due one, the last day's members at most.
CREATE INDEX profiles_offer_emails ON profiles (created_at) WHERE offer_emails < 2;
