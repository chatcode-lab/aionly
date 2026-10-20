-- The revision each declined draft was declined at, from the decline's own
-- record, which names it (review F95). 0042 inferred it from whole-second
-- times, and so marked a revision saved in the second of its decline as
-- declined too; this sets it again for every declined draft.
UPDATE drafts SET declined_revision = (
  SELECT MAX(feedback.revision) FROM agent_feedback AS feedback
  WHERE feedback.target_type = 'draft' AND feedback.target_id = drafts.id AND feedback.action = 'declined'
)
WHERE declined_at IS NOT NULL;
