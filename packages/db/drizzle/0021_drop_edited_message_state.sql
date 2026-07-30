-- Drop the `edited` message state.
--
-- `state = 'edited'` was introduced to drive an early Scene-tracker experiment
-- (wipe the tracker when the message was edited). That shipped, proved awful UX
-- (a typo fix nuked the scene record), and was removed — but MessageStore kept
-- flipping `state` to 'edited' on every edit, and nothing read it back. The
-- only consumer of `state` (the AI message-editor target check) rejected
-- anything but 'complete', so after a single edit the editor could never be
-- reopened on that message (and the same applied to manual edits).
--
-- The store no longer writes 'edited' (it leaves the committed state, always
-- 'complete', untouched), so no NEW rows carry it. This migration sanitizes
-- EXISTING data in every deployed DB: any message left at 'edited' is, by
-- definition, a committed message that was merely edited afterwards — exactly
-- what 'complete' now means. No information is lost; the 'edited' vs 'complete'
-- distinction had no reader.
UPDATE `messages`
SET `state` = 'complete'
WHERE `state` = 'edited';
