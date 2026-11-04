ALTER TABLE `experience_copilot_threads` ADD `history_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_thread_context_events_feed_seek` ON `agent_thread_context_events` (`thread_id`,`seq`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_experience_copilot_messages_feed_seek` ON `experience_copilot_messages` (`thread_id`,`seq`,`created_at`,`id`);--> statement-breakpoint
-- AFP-8: SQL counterpart of compareTimelineEntries (SC-1): NULL seq first,
-- then seq, created_at, id. Probe ONLY each table's indexed head, never its
-- payload. A new key must be STRICTLY after BOTH heads to prove a suffix.
-- BEFORE INSERT also sees an id being replaced, even when recursive_triggers
-- is OFF (SQLite does not fire REPLACE's implicit delete triggers then).
-- Conflicting ignored inserts may conservatively invalidate; failed statements
-- and outer transaction rollbacks undo the epoch together with the row write.
CREATE TRIGGER agent_feed_messages_insert BEFORE INSERT ON experience_copilot_messages
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT seq, created_at, id FROM experience_copilot_messages
    WHERE thread_id = NEW.thread_id ORDER BY seq DESC, created_at DESC, id DESC LIMIT 1
  ) AS head
  WHERE (NEW.seq IS NULL AND head.seq IS NOT NULL) OR head.seq > NEW.seq
    OR (head.seq IS NEW.seq AND (head.created_at, head.id) >= (NEW.created_at, NEW.id))
) OR EXISTS (
  SELECT 1 FROM (
    SELECT seq, created_at, id FROM agent_thread_context_events
    WHERE thread_id = NEW.thread_id ORDER BY seq DESC, created_at DESC, id DESC LIMIT 1
  ) AS head
  WHERE (NEW.seq IS NULL AND head.seq IS NOT NULL) OR head.seq > NEW.seq
    OR (head.seq IS NEW.seq AND (head.created_at, head.id) >= (NEW.created_at, NEW.id))
) OR EXISTS (SELECT 1 FROM experience_copilot_messages WHERE id = NEW.id)
BEGIN
  UPDATE experience_copilot_threads SET history_epoch = history_epoch + 1
  WHERE id = NEW.thread_id OR id = (SELECT thread_id FROM experience_copilot_messages WHERE id = NEW.id);
END;--> statement-breakpoint
CREATE TRIGGER agent_feed_events_insert BEFORE INSERT ON agent_thread_context_events
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT seq, created_at, id FROM experience_copilot_messages
    WHERE thread_id = NEW.thread_id ORDER BY seq DESC, created_at DESC, id DESC LIMIT 1
  ) AS head
  WHERE (NEW.seq IS NULL AND head.seq IS NOT NULL) OR head.seq > NEW.seq
    OR (head.seq IS NEW.seq AND (head.created_at, head.id) >= (NEW.created_at, NEW.id))
) OR EXISTS (
  SELECT 1 FROM (
    SELECT seq, created_at, id FROM agent_thread_context_events
    WHERE thread_id = NEW.thread_id ORDER BY seq DESC, created_at DESC, id DESC LIMIT 1
  ) AS head
  WHERE (NEW.seq IS NULL AND head.seq IS NOT NULL) OR head.seq > NEW.seq
    OR (head.seq IS NEW.seq AND (head.created_at, head.id) >= (NEW.created_at, NEW.id))
) OR EXISTS (SELECT 1 FROM agent_thread_context_events WHERE id = NEW.id)
BEGIN
  UPDATE experience_copilot_threads SET history_epoch = history_epoch + 1
  WHERE id = NEW.thread_id OR id = (SELECT thread_id FROM agent_thread_context_events WHERE id = NEW.id);
END;--> statement-breakpoint
CREATE TRIGGER agent_feed_messages_update AFTER UPDATE ON experience_copilot_messages
WHEN OLD.id IS NOT NEW.id OR OLD.thread_id IS NOT NEW.thread_id
  OR OLD.role IS NOT NEW.role OR OLD.content IS NOT NEW.content
  OR OLD.tool_calls_json IS NOT NEW.tool_calls_json OR OLD.tool_call_id IS NOT NEW.tool_call_id
  OR OLD.reasoning IS NOT NEW.reasoning OR OLD.reasoning_duration_ms IS NOT NEW.reasoning_duration_ms
  OR OLD.attachments_json IS NOT NEW.attachments_json OR OLD.seq IS NOT NEW.seq
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  UPDATE experience_copilot_threads SET history_epoch = history_epoch + 1
  WHERE id IN (OLD.thread_id, NEW.thread_id);
END;--> statement-breakpoint
CREATE TRIGGER agent_feed_events_update AFTER UPDATE ON agent_thread_context_events
WHEN OLD.id IS NOT NEW.id OR OLD.thread_id IS NOT NEW.thread_id
  OR OLD.kind IS NOT NEW.kind OR OLD.payload_json IS NOT NEW.payload_json
  OR OLD.seq IS NOT NEW.seq OR OLD.created_at IS NOT NEW.created_at
BEGIN
  UPDATE experience_copilot_threads SET history_epoch = history_epoch + 1
  WHERE id IN (OLD.thread_id, NEW.thread_id);
END;--> statement-breakpoint
CREATE TRIGGER agent_feed_messages_delete AFTER DELETE ON experience_copilot_messages
BEGIN
  UPDATE experience_copilot_threads SET history_epoch = history_epoch + 1 WHERE id = OLD.thread_id;
END;--> statement-breakpoint
CREATE TRIGGER agent_feed_events_delete AFTER DELETE ON agent_thread_context_events
BEGIN
  UPDATE experience_copilot_threads SET history_epoch = history_epoch + 1 WHERE id = OLD.thread_id;
END;
