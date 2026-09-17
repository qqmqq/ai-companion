-- Phase 2：记忆、上下文快照、摘要、模型用量、Provider 配置与任务路由。
-- 密钥永远不在这里：model_providers.credential_ref 只指向 CredentialStore。

-- 消息状态：流式响应必须能表达 partial / completed / failed，且流中断不留脏数据。
ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE messages ADD COLUMN error_text TEXT;
ALTER TABLE messages ADD COLUMN provider_message_id_ext TEXT;

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                     -- global | user | character | conversation | event | world
  type TEXT NOT NULL,                      -- fact | preference | identity | event | promise | emotion_peak | summary
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,              -- 去重（同内容同作用域合并）
  importance REAL NOT NULL DEFAULT 0.5,    -- 0..1
  confidence REAL NOT NULL DEFAULT 0.5,    -- 0..1
  user_id TEXT,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  reinforcement REAL NOT NULL DEFAULT 1,   -- 被再次提及/确认时累加
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  embedding_json TEXT,                     -- 预留：Phase 2 默认 NULL
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | merged | archived | forgotten
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memories_scope ON memories(scope, status, character_id, user_id);
CREATE INDEX idx_memories_importance ON memories(importance DESC, updated_at DESC);
CREATE INDEX idx_memories_hash ON memories(content_hash);
CREATE INDEX idx_memories_conversation ON memories(conversation_id, created_at DESC);
CREATE INDEX idx_memories_source_message ON memories(source_message_id);

-- FTS5：写入时对中文做逐字切分后索引（trigram 无法命中 <3 字查询）。
CREATE VIRTUAL TABLE memories_fts USING fts5(
  search_text,
  memory_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  relation TEXT NOT NULL,                  -- same_event | same_subject | causes | contradicts | supersedes | derived_from
  target_type TEXT NOT NULL,               -- memory | message | character | user | conversation
  target_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_links_from ON memory_links(from_memory_id, relation);
CREATE INDEX idx_memory_links_target ON memory_links(target_type, target_id);

CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_message_id TEXT NOT NULL,
  to_message_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  token_estimate INTEGER,
  model TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_summaries_conversation ON conversation_summaries(conversation_id, created_at DESC);

CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  total_tokens INTEGER NOT NULL,
  budget_tokens INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  memory_ids_json TEXT NOT NULL DEFAULT '[]',
  dropped_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_snapshots_conversation ON context_snapshots(conversation_id, created_at DESC);
CREATE INDEX idx_snapshots_message ON context_snapshots(message_id);

CREATE TABLE model_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- openai-compatible | ollama | echo
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  default_model TEXT NOT NULL,
  credential_ref TEXT,                     -- CredentialStore 的 accountId；不含任何密钥
  requires_credential INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_routes (
  task_type TEXT PRIMARY KEY,
  provider_id TEXT,
  model TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  input_tokens INTEGER,                    -- Provider 不返回 usage 时为 NULL（不伪造）
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost REAL,
  latency_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error_kind TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_created ON model_usage(created_at DESC);
CREATE INDEX idx_usage_task ON model_usage(task_type, created_at DESC);
CREATE INDEX idx_usage_conversation ON model_usage(conversation_id, created_at DESC);
