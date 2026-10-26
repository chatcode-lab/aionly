-- The digest a visitor chose on the way in, kept with their account as it is
-- written (review F135), so every way its profile is made, at sign-up or by
-- a later repair, starts with that choice rather than the daily default.
ALTER TABLE "user" ADD COLUMN "signupDigest" TEXT CHECK ("signupDigest" IN ('daily', 'weekly', 'monthly'));
