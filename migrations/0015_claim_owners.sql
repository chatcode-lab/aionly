-- Who holds a checkout claim: the request that took it, so only it can
-- release the claim, and it can check it still holds the claim before
-- making a checkout.
ALTER TABLE checkout_claims ADD COLUMN token TEXT NOT NULL DEFAULT '';
