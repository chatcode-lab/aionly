-- Files let go of, waiting for their object to be deleted from the bucket
-- (review F94): a draft's files a publication or a save leaves out, and
-- draft files nothing uses. The write that drops a file's row queues its
-- key here in the same batch; the key leaves once the bucket's delete
-- succeeds, and the hourly run retries what is left.
CREATE TABLE file_deletions (
  key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
);

-- The revision an owner declined, so a later revision waits for them again
-- however soon it comes (review F95). Declined drafts unchanged since then
-- keep that revision; one changed after its decline waits.
ALTER TABLE drafts ADD COLUMN declined_revision INTEGER;
UPDATE drafts SET declined_revision = revision WHERE declined_at IS NOT NULL AND updated_at <= declined_at;
