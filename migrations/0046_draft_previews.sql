-- A link draft's preview, as the Drafts page's Preview made it, kept so it
-- shows again (owner's request, 2026-10-20): the checked link as JSON
-- (`for` the draft's link it was made for, its address, host, provider,
-- aspect, page title, and whether it is already posted), and its snapshot,
-- held as one of the draft's files. A change of link drops both.
ALTER TABLE drafts ADD COLUMN preview TEXT;
ALTER TABLE drafts ADD COLUMN preview_thumb_key TEXT;
