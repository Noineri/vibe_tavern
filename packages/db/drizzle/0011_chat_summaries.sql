-- Branch-scoped ranged chat summaries for Memory 1.0
ALTER TABLE chats ADD COLUMN auto_summary_config_json text NOT NULL DEFAULT '{"enabled":false,"everyN":20,"useChatModel":true}';

CREATE TABLE chat_summaries (
  id text PRIMARY KEY NOT NULL,
  chat_id text NOT NULL,
  branch_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  summarized_from integer NOT NULL DEFAULT 1,
  summarized_to integer NOT NULL DEFAULT 0,
  include_in_context integer NOT NULL DEFAULT 1,
  exclude_summarized integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'manual',
  sort_order integer NOT NULL DEFAULT 0,
  content_hash text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE cascade,
  FOREIGN KEY (branch_id) REFERENCES chat_branches(id) ON DELETE cascade
);

CREATE INDEX idx_chat_summaries_chat_branch ON chat_summaries(chat_id, branch_id);
