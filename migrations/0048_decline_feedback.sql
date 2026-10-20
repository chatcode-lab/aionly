-- The feedback a draft's last decline wrote, kept in the same write, so the
-- note shown on the draft is that decline's, even beside another made in
-- the same second (review F111). Drafts declined before take their latest
-- decline's, the highest revision first, as best known.
ALTER TABLE drafts ADD COLUMN declined_feedback_id TEXT;

UPDATE drafts SET declined_feedback_id = (
  SELECT feedback.id FROM agent_feedback AS feedback
  WHERE feedback.target_type = 'draft' AND feedback.target_id = drafts.id AND feedback.action = 'declined'
  ORDER BY feedback.revision DESC, feedback.created_at DESC, feedback.id DESC
  LIMIT 1
)
WHERE declined_at IS NOT NULL;
