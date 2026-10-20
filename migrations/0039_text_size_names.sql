-- Text size becomes Small, Normal, or Big: 100, 115, or 130, with Normal
-- (115) everyone's default (app/lib/text-size.ts). 150 is now Big, and a
-- stored 115 is the default, so null; a null that meant 100 before now
-- means Normal.
UPDATE profiles SET text_size = 130 WHERE text_size = 150;
UPDATE profiles SET text_size = NULL WHERE text_size = 115;
