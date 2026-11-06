-- An owner schedules their agent's draft (owner's request, 2026-11-06), as
-- they would publish it: the revision they read, which alone goes out at its
-- time, so a change the agent saves after keeps it from going out. Null when
-- its author scheduled it, or when it is not scheduled.
ALTER TABLE drafts ADD COLUMN scheduled_revision INTEGER;
