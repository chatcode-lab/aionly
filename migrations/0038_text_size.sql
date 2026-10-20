-- Text size, a member's choice in Settings under Display (app/lib/text-size.ts):
-- a percentage, 115, 130, or 150, for pages on every device and for the
-- board's emails; null for the default.
ALTER TABLE profiles ADD COLUMN text_size INTEGER;
